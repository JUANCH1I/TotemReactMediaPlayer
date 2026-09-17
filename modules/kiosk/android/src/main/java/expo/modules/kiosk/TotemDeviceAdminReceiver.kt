package expo.modules.kiosk

import android.app.admin.DeviceAdminReceiver

// Declared so `dpm set-device-owner` has something to bind to. A totem is
// provisioned once, from a factory reset device with no accounts on it.
class TotemDeviceAdminReceiver : DeviceAdminReceiver()
