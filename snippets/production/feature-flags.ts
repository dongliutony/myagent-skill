/**
 * Feature Flag 系统 — 双层缓存 + 编译时/运行时 Gate
 *
 * 模式：内存热缓存 + 磁盘持久缓存 + 非阻塞读取
 * 关键点：
 * - 编译时 Gate：feature('FLAG') → 死代码消除
 * - 运行时 Gate：非阻塞缓存读取
 * - 刷新：内部 20 分钟 / 外部 6 小时
 * - 初始化 5s 超时不阻塞
 * - 安全 Gate：等待 reinit 完成
 */

// ========== 双层缓存 ==========

const memoryCache = new Map<string, unknown>()
let diskCachePath: string

async function getFeatureValue<T>(
  flag: string,
  defaultValue: T,
): Promise<T> {
  // 层 1：内存（热缓存）
  if (memoryCache.has(flag)) {
    return memoryCache.get(flag) as T
  }

  // 层 2：磁盘（持久缓存）
  const diskValue = await readDiskCache(flag)
  if (diskValue !== undefined) {
    memoryCache.set(flag, diskValue)
    return diskValue as T
  }

  return defaultValue
}

// 非阻塞版本（可能返回陈旧值）
function getFeatureValue_CACHED<T>(flag: string, defaultValue: T): T {
  return (memoryCache.get(flag) as T) ?? defaultValue
}

// ========== 刷新机制 ==========

const REFRESH_INTERVAL_INTERNAL = 20 * 60 * 1000    // 20 分钟
const REFRESH_INTERVAL_EXTERNAL = 6 * 60 * 60 * 1000 // 6 小时
const INIT_TIMEOUT_MS = 5_000

let initPromise: Promise<void> | null = null
let reinitPromise: Promise<void> | null = null

async function initializeFlags(config: FlagConfig): Promise<void> {
  initPromise = withTimeout(
    fetchAndCacheFlags(config),
    INIT_TIMEOUT_MS,
  ).catch(() => {
    // 超时 → 使用磁盘缓存或默认值
    console.warn('Feature flag init timed out, using cached values')
  })

  await initPromise

  // 启动定期刷新
  const interval = config.isInternal
    ? REFRESH_INTERVAL_INTERNAL
    : REFRESH_INTERVAL_EXTERNAL

  setInterval(() => refreshFlags(config), interval)
}

async function refreshFlags(config: FlagConfig): Promise<void> {
  reinitPromise = fetchAndCacheFlags(config)
  await reinitPromise
  reinitPromise = null
}

// ========== 安全 Gate（等待 reinit） ==========

async function checkSecurityGate(flag: string): Promise<boolean> {
  // 安全相关的 flag 必须等待 reinit 完成
  if (reinitPromise) {
    await reinitPromise
  }
  return getFeatureValue_CACHED(flag, false)
}

// ========== 覆盖机制 ==========

// 环境变量覆盖（测试/评估用）
function loadOverrides(): Map<string, unknown> {
  const overrides = new Map<string, unknown>()

  // 环境变量
  const envOverrides = process.env.FLAG_OVERRIDES
  if (envOverrides) {
    const parsed = JSON.parse(envOverrides)
    for (const [key, value] of Object.entries(parsed)) {
      overrides.set(key, value)
    }
  }

  // 本地配置
  const localOverrides = getLocalConfig().flagOverrides
  if (localOverrides) {
    for (const [key, value] of Object.entries(localOverrides)) {
      overrides.set(key, value)
    }
  }

  return overrides
}

// ========== 配置驱动行为 ==========

// 设置优先级（高→低）
function resolveSettings(): Settings {
  const layers = [
    loadUserSettings(),            // ~/.settings.json
    loadRemoteManagedSettings(),   // /api/settings（1h 轮询）
    loadManagedFile(),             // ~/.managed-settings.json
    ...loadDropInConfigs(),        // ~/.managed-settings.d/*.json
    getBuiltinDefaults(),
  ]

  return mergeSettingsLayers(layers)
}

// Drop-in 目录：独立策略片段
function loadDropInConfigs(): Settings[] {
  const dropInDir = path.join(os.homedir(), '.agent', 'managed-settings.d')
  const files = fs.readdirSync(dropInDir)
    .filter(f => f.endsWith('.json'))
    .sort()  // 字母排序

  return files.map(f =>
    JSON.parse(fs.readFileSync(path.join(dropInDir, f), 'utf-8'))
  )
}
