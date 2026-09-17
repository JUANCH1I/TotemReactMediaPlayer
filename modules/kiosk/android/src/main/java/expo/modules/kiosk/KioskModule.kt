package expo.modules.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Turns a television into a totem: the app cannot be left, and the network can
// be configured from inside it, rotated like everything else the app draws.
//
// All of this depends on the app being the device owner, which is granted once
// per television from a factory reset state with no accounts on it:
//   adb shell dpm set-device-owner com.juanch1.Totem/expo.modules.kiosk.TotemDeviceAdminReceiver
// Without that, Android refuses to let a third party app manage Wi-Fi at all,
// and this module reports notOwner so the app can fall back to the system
// screens instead of pretending.
class KioskModule : Module() {
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

  override fun definition() = ModuleDefinition {
    Name("Kiosk")

    Function<Boolean>("isDeviceOwner") { -> policyManager.isDeviceOwnerApp(context.packageName) }

    // Locks the screen to this app: home and recents stop working, and the
    // status bar is out of reach.
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

    // The only way back from a provisioned totem. adb cannot do this: Android
    // refuses to remove a device owner that is not a test admin, so without
    // this the screen can only be recovered by a factory reset.
    @Suppress("DEPRECATION")
    Function<Unit>("releaseDevice") { ->
      requireOwner()
      activity?.stopLockTask()
      policyManager.clearPackagePersistentPreferredActivities(admin, context.packageName)
      policyManager.clearDeviceOwnerApp(context.packageName)
    }

    Function<Unit>("clearHome") { ->
      requireOwner()
      policyManager.clearPackagePersistentPreferredActivities(admin, context.packageName)
    }

    // A device owner can grant itself the permissions a Wi-Fi scan needs, so
    // the installer never has to answer a system dialog with a remote.
    Function<Unit>("grantWifiPermissions") { ->
      requireOwner()
      val permissions = mutableListOf(
        android.Manifest.permission.ACCESS_FINE_LOCATION,
      )
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

    Function("scanNetworks") { ->
      requireOwner()
      if (context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
        != PackageManager.PERMISSION_GRANTED
      ) {
        throw CodedException("ERR_NO_SCAN_PERMISSION", "Scanning needs the location permission", null)
      }

      wifiManager.scanResults
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
    Function("connect") { ssid: String, password: String? ->
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

      enabled
    }

    Function("currentNetwork") { ->
      val info = wifiManager.connectionInfo
      val ssid = info?.ssid?.trim('"')

      if (ssid.isNullOrBlank() || ssid == "<unknown ssid>") null else ssid
    }
  }
}
