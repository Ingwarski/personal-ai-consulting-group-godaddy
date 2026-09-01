export interface RegistrarStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(operation: (storage: RegistrarStorage) => Promise<T>): Promise<T>;
}
