import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type StoredCredentials = {
  api_key: string
  key_id?: string
  key_name?: string
  workspace?: { kind: "personal" | "team"; name: string }
  site_url?: string
  created_at?: string
}

/** OSINTVERSE_CONFIG_DIR, else %APPDATA%\osintverse on Windows, else $XDG_CONFIG_HOME or ~/.config. */
export function configPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.OSINTVERSE_CONFIG_DIR) return join(env.OSINTVERSE_CONFIG_DIR, "config.json")
  const base =
    process.platform === "win32"
      ? env.APPDATA ?? join(homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "osintverse", "config.json")
}

export function readCredentials(path = configPath()): StoredCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredCredentials
    return typeof parsed.api_key === "string" && parsed.api_key ? parsed : null
  } catch {
    return null
  }
}

export function writeCredentials(credentials: StoredCredentials, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file lives under the user's own profile.
  }
}

export function deleteCredentials(path = configPath()) {
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
