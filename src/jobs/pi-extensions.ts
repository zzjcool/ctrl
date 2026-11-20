import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const PROVIDER_PACKAGE = "pi-any-endpoint"

export function providerExtensionPath(home: string = homedir()): string | undefined {
  const root = path.join(home, ".pi", "agent", "npm")
  let installs: string[]
  try {
    installs = readdirSync(root)
  } catch {
    return undefined
  }
  for (const install of installs) {
    const candidate = path.join(root, install, PROVIDER_PACKAGE, "extensions", "index.ts")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
