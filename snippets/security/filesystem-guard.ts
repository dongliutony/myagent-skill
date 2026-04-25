/**
 * 文件系统安全守卫
 *
 * 模式：受保护列表 + 遍历防护 + 大小写标准化
 * 关键点：
 * - 受保护文件和目录白名单
 * - 路径遍历检测（..、UNC、设备路径）
 * - 工作目录边界检查
 */

// ========== 受保护资源 ==========

const DANGEROUS_FILES = new Set([
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile',
  '.ripgreprc',
  '.mcp.json', '.claude.json',
])

const DANGEROUS_DIRECTORIES = new Set([
  '.git', '.vscode', '.idea', '.claude',
])

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console',
  '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
])

// ========== 路径安全检查 ==========

interface PathCheckResult {
  safe: boolean
  reason?: string
}

function checkPathSafety(filePath: string, cwd: string): PathCheckResult {
  // 设备路径
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return { safe: false, reason: `Blocked device path: ${filePath}` }
  }

  // UNC 路径（Windows NTLM 凭据泄露）
  if (filePath.startsWith('\\\\')) {
    return { safe: false, reason: 'UNC paths blocked to prevent credential leak' }
  }

  // 路径遍历
  const normalized = path.resolve(filePath)
  if (normalized !== filePath && filePath.includes('..')) {
    return { safe: false, reason: 'Path traversal detected' }
  }

  // 受保护文件
  const basename = path.basename(normalized)
  if (DANGEROUS_FILES.has(normalizeCaseForComparison(basename))) {
    return { safe: false, reason: `Protected file: ${basename}` }
  }

  // 受保护目录
  const parts = normalized.split(path.sep)
  for (const part of parts) {
    if (DANGEROUS_DIRECTORIES.has(normalizeCaseForComparison(part))) {
      return { safe: false, reason: `Protected directory: ${part}` }
    }
  }

  return { safe: true }
}

// ========== 工作目录边界 ==========

function isWithinWorkingDirectory(
  filePath: string,
  cwd: string,
  additionalDirs?: string[],
): boolean {
  const normalized = path.resolve(filePath)
  const normalizedCwd = path.resolve(cwd)

  // 主工作目录
  if (normalized.startsWith(normalizedCwd + path.sep) || normalized === normalizedCwd) {
    return true
  }

  // 额外允许的目录
  for (const dir of additionalDirs ?? []) {
    const normalizedDir = path.resolve(dir)
    if (normalized.startsWith(normalizedDir + path.sep) || normalized === normalizedDir) {
      return true
    }
  }

  return false
}

// ========== 大小写标准化（跨平台） ==========

function normalizeCaseForComparison(name: string): string {
  // macOS/Windows 文件系统大小写不敏感
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return name.toLowerCase()
  }
  return name
}

// ========== 三级风险评分 ==========

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

const RISK_COLORS: Record<RiskLevel, string> = {
  LOW: 'green',
  MEDIUM: 'yellow',
  HIGH: 'red',
}

const RISK_NUMERIC: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
}
