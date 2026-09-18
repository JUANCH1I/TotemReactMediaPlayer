import { NativeModule, requireNativeModule } from 'expo';

export type WifiNetwork = {
  ssid: string;
  /** 0 to 4. */
  level: number;
  secured: boolean;
};

export type SetupSession = {
  ssid: string | null;
  password: string | null;
  url: string | null;
  /** Data URI: scanned by a phone to join the totem's network. */
  joinQr: string;
  /** Data URI: opens the setup page once joined. */
  pageQr: string | null;
};

declare class KioskModule extends NativeModule {
  /** Everything else here needs this to be true. */
  isDeviceOwner(): boolean;
  /** Pins the screen to this app: home and recents stop leaving it. */
  lock(): void;
  unlock(): void;
  /** Pins this app as the home screen, over the television's own launcher. */
  setAsHome(): void;
  clearHome(): void;
  /** Gives the television back: unlocks, drops the home pin and the ownership. */
  releaseDevice(): void;
  /**
   * Raises the totem's own network and serves the setup page on it, for a
   * venue where there is no connection yet. Returns what the screen has to
   * show: the credentials, the address, and QR codes for both.
   */
  startSetup(): Promise<SetupSession>;
  stopSetup(): void;
  /** A device owner grants itself what a scan needs, with no dialogs. */
  grantWifiPermissions(): void;
  scanNetworks(): WifiNetwork[];
  /** Pass no password for an open network. Returns whether it was accepted. */
  connect(ssid: string, password?: string | null): boolean;
  currentNetwork(): string | null;
  /** Data URI of a QR drawn on the device, for screens with no internet. */
  qrCode(payload: string, size?: number): string;
}

export default requireNativeModule<KioskModule>('Kiosk');
