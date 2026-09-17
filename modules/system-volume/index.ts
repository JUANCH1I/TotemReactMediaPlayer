import { NativeModule, requireNativeModule } from 'expo';

export type VolumeChangeEvent = { volume: number };

type SystemVolumeEvents = {
  onVolumeChange: (event: VolumeChangeEvent) => void;
};

declare class SystemVolumeModule extends NativeModule<SystemVolumeEvents> {
  /** Current media volume, 0 to 1. */
  getVolume(): number;
  /** Sets the media volume, 0 to 1, and returns the level actually applied. */
  setVolume(level: number): number;
  /** Starts reporting volume changes made outside the app, such as the remote. */
  startWatching(): void;
  stopWatching(): void;
}

export default requireNativeModule<SystemVolumeModule>('SystemVolume');
