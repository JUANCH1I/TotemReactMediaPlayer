import { NativeModule, requireNativeModule } from 'expo';

export type WifiNetwork = {
  ssid: string;
  /** 0 to 4. */
  level: number;
  secured: boolean;
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
  /** A device owner grants itself what a scan needs, with no dialogs. */
  grantWifiPermissions(): void;
  scanNetworks(): WifiNetwork[];
  /** Pass no password for an open network. Returns whether it was accepted. */
  connect(ssid: string, password?: string | null): boolean;
  currentNetwork(): string | null;
}

export default requireNativeModule<KioskModule>('Kiosk');
