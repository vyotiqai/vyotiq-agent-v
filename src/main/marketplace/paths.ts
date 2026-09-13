import { app } from 'electron'
import { join } from 'path'
import { userDataRoot } from '../storage/paths'
import {
  assertSafePackagePath,
  resolveInsideBundledMarketplace,
  resolveInsideMarketplacePackages
} from './safePath'

export function marketplaceRoot(): string {
  return join(userDataRoot(), 'marketplace')
}

export function marketplaceIndexPath(): string {
  return join(marketplaceRoot(), 'index.json')
}

export function marketplaceCatalogCachePath(): string {
  return join(marketplaceRoot(), 'cache', 'catalog.json')
}

export function marketplacePackagesRoot(): string {
  return join(marketplaceRoot(), 'packages')
}

export function marketplacePackageDir(id: string, version: string): string {
  return resolveInsideMarketplacePackages(id, version)
}

/** Bundled catalog + packages (dev vs packaged). */
export function bundledMarketplaceRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'marketplace')
  }
  return join(app.getAppPath(), 'resources', 'marketplace')
}

export function bundledCatalogPath(): string {
  return join(bundledMarketplaceRoot(), 'catalog.json')
}

export function bundledPackagePath(relativePath: string): string {
  const safe = relativePath.trim().replace(/\\/g, '/')
  return resolveInsideBundledMarketplace(`packages/${safe}`)
}

/** Resolve a path under resources/marketplace/ (icons, etc.). */
export function bundledMarketplaceAssetPath(relativePath: string): string {
  return resolveInsideBundledMarketplace(relativePath)
}

export function resolveInstalledPackageRoot(packagePath: string): string {
  const safe = assertSafePackagePath(packagePath)
  const [id, version] = safe.split('/')
  return resolveInsideMarketplacePackages(id!, version!)
}
