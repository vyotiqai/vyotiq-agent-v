import { ipcMain } from 'electron'
import { IPC } from '../../../shared/channels'
import { detectSetupOptions, envKeyFor } from '../../app/setupDetect'
import {
  SetupUseEnvKeyRequestSchema,
  SetToolSecretRequestSchema,
  ClearToolSecretRequestSchema,
  type ToolSecretStatus,
  ok,
  fail,
  type IpcResult
} from '../../../shared/ipc'
import { getSettings } from '@main/settings/settings'
import {
  setSecret,
  secretStatus,
  setToolSecret,
  clearToolSecret,
  toolSecretStatus,
  enqueueSecretsMutation
} from '@main/settings/secrets'
import { applyNetworkSettings } from '@main/net/proxy'
import { clearModelCache } from '../../agent/providers/modelCache'
import { failExpected, failFrom, senderOk } from '../ipcShared'

/** Tool keys in the key vault, and what first-run setup can offer. Registered once by registerIpc. */
export function registerSecretsIpc(): void {
  ipcMain.handle(IPC.toolSecretSet, async (event, raw): Promise<IpcResult<ToolSecretStatus>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SetToolSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setToolSecret(req.name, req.key))
      if (req.name === 'proxy') await applyNetworkSettings(getSettings().network)
      return ok(toolSecretStatus())
    } catch (err) {
      return failFrom(err, IPC.toolSecretSet)
    }
  })

  ipcMain.handle(IPC.toolSecretClear, async (event, raw): Promise<IpcResult<ToolSecretStatus>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ClearToolSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => clearToolSecret(req.name))
      if (req.name === 'proxy') await applyNetworkSettings(getSettings().network)
      return ok(toolSecretStatus())
    } catch (err) {
      return failFrom(err, IPC.toolSecretClear)
    }
  })

  ipcMain.handle(IPC.toolSecretStatus, async (event): Promise<IpcResult<ToolSecretStatus>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(toolSecretStatus())
    } catch (err) {
      return failFrom(err, IPC.toolSecretStatus)
    }
  })

  ipcMain.handle(IPC.setupDetect, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const saved = secretStatus().keys
      return ok(await detectSetupOptions({ hasKey: (provider) => saved[provider] === true }))
    } catch (err) {
      return failFrom(err, IPC.setupDetect)
    }
  })

  ipcMain.handle(IPC.setupUseEnvKey, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { provider } = SetupUseEnvKeyRequestSchema.parse(raw)
      const found = envKeyFor(provider)
      if (!found) return failExpected('That key is no longer in the environment.', IPC.setupUseEnvKey)
      await enqueueSecretsMutation(() => setSecret(provider, found.value))
      clearModelCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.setupUseEnvKey)
    }
  })
}
