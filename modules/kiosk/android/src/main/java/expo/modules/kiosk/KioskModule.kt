package expo.modules.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.NetworkInterface

// Turns a television into a totem: the app cannot be left, and the network can
// be configured from inside it, rotated like everything else the app draws.
//
// All of this depends on the app being the device owner, which is granted once
// per television from a factory reset state with no accounts on it:
//   adb shell dpm set-device-owner com.juanch1.Totem/expo.modules.kiosk.TotemDeviceAdminReceiver
// Without that, Android refuses to let a third party app manage Wi-Fi at all,
// and every entry point here fails loudly so the app can fall back instead of
// pretending.
//
// Note: startObserving and stopObserving are reserved by the Expo event system.
private const val SETUP_PORT = 8088

// The panel backlight on the MediaTek televisions we use (Innova / KTC Google
// TV), 0 to 100. Settings.System screen_brightness does nothing on them. It is
// a Global setting, so writing it needs WRITE_SECURE_SETTINGS, which being
// device owner does not give: it is granted once per television over adb,
//   adb shell pm grant com.juanch1.Totem android.permission.WRITE_SECURE_SETTINGS
private const val PICTURE_BACKLIGHT = "picture_backlight"

class KioskModule : Module() {
  // Both are held for as long as setup lasts: Android tears the hotspot down
  // the moment its reservation is released.
  private var hotspot: WifiManager.LocalOnlyHotspotReservation? = null
  private var server: SetupServer? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val activity: Activity?
    get() = appContext.currentActivity

  private val policyManager: DevicePolicyManager
    get() = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

  private val wifiManager: WifiManager
    get() = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

  private val admin: ComponentName
    get() = ComponentName(context, TotemDeviceAdminReceiver::class.java)

  private fun requireOwner() {
    if (!policyManager.isDeviceOwnerApp(context.packageName)) {
      throw CodedException("ERR_NOT_DEVICE_OWNER", "The app is not the device owner", null)
    }
  }

  private fun scanNetworks(): List<Map<String, Any?>> {
    requireOwner()

    if (context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
      != PackageManager.PERMISSION_GRANTED
    ) {
      throw CodedException("ERR_NO_SCAN_PERMISSION", "Scanning needs the location permission", null)
    }

    return wifiManager.scanResults
      .filter { it.SSID.isNotBlank() }
      .groupBy { it.SSID }
      // One entry per network, keeping the strongest reading.
      .map { (ssid, results) ->
        val best = results.maxByOrNull { it.level } ?: results.first()
        mapOf(
          "ssid" to ssid,
          "level" to WifiManager.calculateSignalLevel(best.level, 5),
          "secured" to (best.capabilities.contains("WPA") || best.capabilities.contains("WEP")),
        )
      }
      .sortedByDescending { it["level"] as Int }
  }

  @Suppress("DEPRECATION")
  private fun joinNetwork(ssid: String, password: String?): Boolean {
    requireOwner()

    val configuration = WifiConfiguration().apply {
      SSID = "\"$ssid\""
      if (password.isNullOrEmpty()) {
        allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
      } else {
        preSharedKey = "\"$password\""
      }
    }

    val networkId = wifiManager.addNetwork(configuration)
    if (networkId == -1) {
      throw CodedException("ERR_WIFI_REJECTED", "The network could not be saved", null)
    }

    wifiManager.disconnect()
    val enabled = wifiManager.enableNetwork(networkId, true)
    wifiManager.reconnect()

    return enabled
  }

  @Suppress("DEPRECATION")
  private fun readCurrentNetwork(): String? {
    val ssid = wifiManager.connectionInfo?.ssid?.trim('"')

    return if (ssid.isNullOrBlank() || ssid == "<unknown ssid>") null else ssid
  }

  private fun deviceId(): String? =
    Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)

  // The address a phone reaches once it has joined the totem's own network.
  private fun hotspotAddress(): String? = NetworkInterface.getNetworkInterfaces()
    .toList()
    .asSequence()
    .filter { runCatching { it.isUp }.getOrDefault(false) && !it.isLoopback }
    .flatMap { it.inetAddresses.toList().asSequence() }
    .filterIsInstance<Inet4Address>()
    .mapNotNull { it.hostAddress }
    .firstOrNull { it.startsWith("192.168.") || it.startsWith("172.") }

  // Drawn here because a totem being set up has no internet to fetch one from.
  private fun qrPng(payload: String, size: Int = 480): String {
    val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)

    for (x in 0 until size) {
      for (y in 0 until size) {
        bitmap.setPixel(x, y, if (matrix.get(x, y)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
      }
    }

    val stream = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)

    return "data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
  }

  // False when this television has no such setting or the permission was never
  // granted, so the app can dim the picture itself instead.
  private fun setBacklight(level: Int): Boolean {
    val resolver = context.contentResolver

    if (Settings.Global.getString(resolver, PICTURE_BACKLIGHT) == null) return false

    if (context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS)
      != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }

    return try {
      Settings.Global.putInt(resolver, PICTURE_BACKLIGHT, level.coerceIn(0, 100))
    } catch (error: SecurityException) {
      false
    }
  }

  private fun startServer() {
    server?.stop()
    server = SetupServer(
      port = SETUP_PORT,
      deviceId = deviceId(),
      scan = { scanNetworks() },
      connect = { ssid, password -> joinNetwork(ssid, password) },
      currentNetwork = { readCurrentNetwork() },
    ).also { it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true) }
  }

  private fun stopSetup() {
    server?.stop()
    server = null
    hotspot?.close()
    hotspot = null
  }

  override fun definition() = ModuleDefinition {
    Name("Kiosk")

    Function<Boolean>("isDeviceOwner") { -> policyManager.isDeviceOwnerApp(context.packageName) }

    // Locks the screen to this app: home and recents stop leaving it.
    Function<Unit>("lock") { ->
      requireOwner()
      policyManager.setLockTaskPackages(admin, arrayOf(context.packageName))
      activity?.startLockTask()
    }

    Function<Unit>("unlock") { -> activity?.stopLockTask() }

    // Being declared in the manifest is not enough: the television keeps its
    // own launcher as the preferred one. A device owner can pin the choice so
    // the totem is what a power cut, or the home button, comes back to.
    Function<Unit>("setAsHome") { ->
      requireOwner()
      val launcher = context.packageManager
        .getLaunchIntentForPackage(context.packageName)
        ?.component
        ?: throw CodedException("ERR_NO_LAUNCH_ACTIVITY", "The app has no launch activity", null)

      val filter = IntentFilter(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME)
        addCategory(Intent.CATEGORY_DEFAULT)
      }

      policyManager.addPersistentPreferredActivity(admin, filter, launcher)
    }

    Function<Unit>("clearHome") { ->
      requireOwner()
      policyManager.clearPackagePersistentPreferredActivities(admin, context.packageName)
    }

    // The only way back from a provisioned totem. adb cannot do this: Android
    // refuses to remove a device owner that is not a test admin, so without
    // this the screen could only be recovered by a factory reset.
    @Suppress("DEPRECATION")
    Function<Unit>("releaseDevice") { ->
      requireOwner()
      stopSetup()
      activity?.stopLockTask()
      policyManager.clearPackagePersistentPreferredActivities(admin, context.packageName)
      policyManager.clearDeviceOwnerApp(context.packageName)
    }

    // A device owner can grant itself the permissions a Wi-Fi scan needs, so
    // the installer never has to answer a system dialog with a remote.
    Function<Unit>("grantWifiPermissions") { ->
      requireOwner()
      val permissions = mutableListOf(android.Manifest.permission.ACCESS_FINE_LOCATION)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        permissions.add(android.Manifest.permission.NEARBY_WIFI_DEVICES)
      }

      permissions.forEach { permission ->
        policyManager.setPermissionGrantState(
          admin,
          context.packageName,
          permission,
          DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
        )
      }
    }

    // Drawn on the device: the screen that shows a pairing code is exactly the
    // screen of a totem that has no internet yet.
    Function("qrCode") { payload: String, size: Int? -> qrPng(payload, size ?: 480) }

    Function("scanNetworks") { -> scanNetworks() }

    Function("connect") { ssid: String, password: String? -> joinNetwork(ssid, password) }

    Function("currentNetwork") { -> readCurrentNetwork() }

    Function("setBacklight") { level: Int -> setBacklight(level) }

    // A totem with no connection cannot be reached from the dashboard, and the
    // system Wi-Fi screens are drawn in the television's own orientation,
    // sideways on a vertical totem. So the totem offers its own network and
    // serves the setup page itself: the installer joins from a phone and types
    // the venue password on a real keyboard.
    AsyncFunction("startSetup") { promise: Promise ->
      var settled = false

      val callback = object : WifiManager.LocalOnlyHotspotCallback() {
        override fun onStarted(reservation: WifiManager.LocalOnlyHotspotReservation) {
          if (settled) return
          settled = true

          hotspot?.close()
          hotspot = reservation

          val ssid: String?
          val password: String?

          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val configuration = reservation.softApConfiguration
            ssid = configuration.ssid
            password = configuration.passphrase
          } else {
            @Suppress("DEPRECATION")
            val configuration = reservation.wifiConfiguration
            @Suppress("DEPRECATION")
            ssid = configuration?.SSID
            @Suppress("DEPRECATION")
            password = configuration?.preSharedKey
          }

          val started = runCatching { startServer() }
          if (started.isFailure) {
            promise.reject(
              CodedException(
                "ERR_SETUP_SERVER",
                started.exceptionOrNull()?.message ?: "server",
                null
              )
            )
            return
          }

          val address = hotspotAddress()

          promise.resolve(
            mapOf(
              "ssid" to ssid,
              "password" to password,
              "url" to address?.let { "http://$it:$SETUP_PORT" },
              // Scanned by the phone to join the totem's network without typing.
              "joinQr" to qrPng("WIFI:S:$ssid;T:WPA;P:$password;;"),
              "pageQr" to address?.let { qrPng("http://$it:$SETUP_PORT") },
            )
          )
        }

        override fun onFailed(reason: Int) {
          if (settled) return
          settled = true
          promise.reject(CodedException("ERR_HOTSPOT_FAILED", "Reason $reason", null))
        }
      }

      try {
        wifiManager.startLocalOnlyHotspot(callback, Handler(Looper.getMainLooper()))
      } catch (error: Throwable) {
        if (!settled) {
          settled = true
          promise.reject(
            CodedException("ERR_HOTSPOT_UNAVAILABLE", error.message ?: "unavailable", null)
          )
        }
      }
    }

    Function<Unit>("stopSetup") { -> stopSetup() }

    OnDestroy { stopSetup() }
  }
}
