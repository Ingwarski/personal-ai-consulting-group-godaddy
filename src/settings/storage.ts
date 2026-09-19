export interface SettingsStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(operation: (storage: SettingsStorage) => Promise<T>): Promise<T>;
}
