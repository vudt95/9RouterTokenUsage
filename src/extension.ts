import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

const SECRET_API_KEY = 'aiTokenUsage.apiKey';

interface ProviderConnection {
  id: string;
  provider: string;
  authType?: string;
  name?: string;
  email?: string;
  priority: number;
  isActive: boolean;
  testStatus?: string;
  expiresAt?: string;
  expiresIn?: number;
  lastRefreshAt?: string;
  lastUsedAt?: string;
  consecutiveUseCount?: number;
  createdAt?: string;
  updatedAt?: string;
  providerSpecificData: Record<string, unknown>;
}

interface QuotaData {
  used: number;
  total: number;
  remaining: number;
  resetAt?: string;
  unlimited: boolean;
}

interface UsageData {
  plan?: string;
  limitReached: boolean;
  reviewLimitReached: boolean;
  quotas: Record<string, QuotaData>;
}

interface ProviderUsage {
  connection: ProviderConnection;
  usage?: UsageData;
  error?: string;
}

interface DashboardData {
  items: ProviderUsage[];
  primary?: ProviderUsage;
  fetchedAt: Date;
}

interface ExtensionConfig {
  baseUrl: string;
  providersPath: string;
  usagePathTemplate: string;
  statusBarQuota: string;
  intervalSeconds: number;
}

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastDashboard: DashboardData | undefined;
let lastError: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'aiTokenUsage.showDetails';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('aiTokenUsage.refresh', () =>
      refresh(context)
    ),
    vscode.commands.registerCommand('aiTokenUsage.setApiKey', () =>
      setApiKey(context)
    ),
    vscode.commands.registerCommand('aiTokenUsage.showDetails', () =>
      showDetails(context)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiTokenUsage.refreshIntervalSeconds')) {
        scheduleRefresh(context);
      }
      if (e.affectsConfiguration('aiTokenUsage')) {
        void refresh(context);
      }
    })
  );

  renderStatusBar();
  void refresh(context);
  scheduleRefresh(context);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('aiTokenUsage');
  return {
    baseUrl: cfg.get<string>('apiBaseUrl', 'http://localhost:20128'),
    providersPath: cfg.get<string>(
      'providersPath',
      '/api/providers?page=1&pageSize=20&accountStatus=all&sort=priority&isActive=true'
    ),
    usagePathTemplate: cfg.get<string>('usagePathTemplate', '/api/usage/{id}'),
    statusBarQuota: cfg.get<string>('statusBarQuota', 'session'),
    intervalSeconds: Math.max(
      10,
      cfg.get<number>('refreshIntervalSeconds', 60)
    )
  };
}

function scheduleRefresh(context: vscode.ExtensionContext): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const { intervalSeconds } = getConfig();
  refreshTimer = setInterval(() => {
    void refresh(context);
  }, intervalSeconds * 1000);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const existing = await context.secrets.get(SECRET_API_KEY);
  const value = await vscode.window.showInputBox({
    title: '9Router Token Usage — API Key',
    prompt: 'Nhập API key của bạn. Để trống để xoá key đã lưu.',
    password: true,
    value: existing ?? '',
    ignoreFocusOut: true,
    placeHolder: 'sk-...'
  });

  if (value === undefined) {
    return;
  }

  if (value.trim() === '') {
    await context.secrets.delete(SECRET_API_KEY);
    vscode.window.showInformationMessage('Đã xoá API key.');
  } else {
    await context.secrets.store(SECRET_API_KEY, value.trim());
    vscode.window.showInformationMessage('Đã lưu API key.');
  }
  await refresh(context);
}

async function refresh(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  if (!apiKey) {
    lastDashboard = undefined;
    lastError = undefined;
    renderStatusBar(true);
    return;
  }

  try {
    lastDashboard = await fetchDashboard(getConfig(), apiKey);
    lastError = undefined;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  renderStatusBar();
}

async function fetchDashboard(
  cfg: ExtensionConfig,
  apiKey: string
): Promise<DashboardData> {
  const providersUrl = buildUrl(cfg.baseUrl, cfg.providersPath);
  const providersJson = await fetchJson(providersUrl, apiKey);
  const connections = parseProviders(providersJson).sort(
    (a, b) => a.priority - b.priority
  );

  const items = await Promise.all(
    connections.map(async (connection): Promise<ProviderUsage> => {
      try {
        const usagePath = buildUsagePath(cfg.usagePathTemplate, connection.id);
        const usageJson = await fetchJson(buildUrl(cfg.baseUrl, usagePath), apiKey);
        return { connection, usage: parseUsage(usageJson) };
      } catch (err) {
        return {
          connection,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    })
  );

  return {
    items,
    primary: items.find((item) => item.connection.priority === 1) ?? items[0],
    fetchedAt: new Date()
  };
}

function buildUrl(baseUrl: string, pathOrUrl: string): URL {
  try {
    return new URL(pathOrUrl, baseUrl);
  } catch {
    throw new Error(`URL không hợp lệ: ${baseUrl} + ${pathOrUrl}`);
  }
}

function buildUsagePath(template: string, providerId: string): string {
  if (template.includes('{id}')) {
    return template.replace(/\{id\}/g, encodeURIComponent(providerId));
  }
  const separator = template.endsWith('/') ? '' : '/';
  return `${template}${separator}${encodeURIComponent(providerId)}`;
}

function fetchJson(target: URL, apiKey: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const client = target.protocol === 'http:' ? http : https;
    const req = client.request(
      target,
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'vscode-9router-token-usage'
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as unknown);
          } catch {
            reject(new Error('Không thể phân tích phản hồi JSON.'));
          }
        });
      }
    );

    req.setTimeout(15000, () => {
      req.destroy(new Error('Hết thời gian chờ phản hồi (timeout).'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function parseProviders(json: unknown): ProviderConnection[] {
  const root = asRecord(json);
  const rawConnections = Array.isArray(root?.connections)
    ? root.connections
    : [];

  return rawConnections
    .map((raw) => normalizeProvider(raw))
    .filter((provider): provider is ProviderConnection => provider !== undefined);
}

function normalizeProvider(raw: unknown): ProviderConnection | undefined {
  const record = asRecord(raw);
  const id = toOptionalString(record?.id);
  if (!record || !id) {
    return undefined;
  }

  const providerSpecificData = asRecord(record.providerSpecificData) ?? {};
  return {
    id,
    provider: toOptionalString(record.provider) ?? 'unknown',
    authType: toOptionalString(record.authType),
    name: toOptionalString(record.name),
    email: toOptionalString(record.email),
    priority: toNumber(record.priority, Number.MAX_SAFE_INTEGER),
    isActive: toBoolean(record.isActive, false),
    testStatus: toOptionalString(record.testStatus),
    expiresAt: toOptionalString(record.expiresAt),
    expiresIn: toOptionalNumber(record.expiresIn),
    lastRefreshAt: toOptionalString(record.lastRefreshAt),
    lastUsedAt: toOptionalString(record.lastUsedAt),
    consecutiveUseCount: toOptionalNumber(record.consecutiveUseCount),
    createdAt: toOptionalString(record.createdAt),
    updatedAt: toOptionalString(record.updatedAt),
    providerSpecificData
  };
}

function parseUsage(json: unknown): UsageData {
  const record = asRecord(json) ?? {};
  const quotasRecord = asRecord(record.quotas) ?? {};
  const quotas: Record<string, QuotaData> = {};

  for (const [name, rawQuota] of Object.entries(quotasRecord)) {
    if (asRecord(rawQuota)) {
      quotas[name] = normalizeQuota(rawQuota);
    }
  }

  return {
    plan: toOptionalString(record.plan),
    limitReached: toBoolean(record.limitReached, false),
    reviewLimitReached: toBoolean(record.reviewLimitReached, false),
    quotas
  };
}

function normalizeQuota(raw: unknown): QuotaData {
  const record = asRecord(raw) ?? {};
  const used = toNumber(record.used, 0);
  const total = toNumber(record.total, 0);
  const remaining =
    record.remaining === undefined || record.remaining === null
      ? Math.max(0, total - used)
      : toNumber(record.remaining, 0);

  return {
    used,
    total,
    remaining,
    resetAt: toOptionalString(record.resetAt),
    unlimited: toBoolean(record.unlimited, false)
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  const n = toNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : undefined;
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }
  }
  return fallback;
}

function renderStatusBar(missingKey = false): void {
  if (missingKey) {
    statusBarItem.text = '$(key) 9Router: chưa có API key';
    statusBarItem.tooltip = 'Bấm để thiết lập API key.';
    statusBarItem.command = 'aiTokenUsage.setApiKey';
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    return;
  }

  statusBarItem.command = 'aiTokenUsage.showDetails';

  if (lastError && !lastDashboard) {
    statusBarItem.text = '$(error) 9Router: lỗi';
    statusBarItem.tooltip = `Không lấy được dữ liệu: ${lastError}\nBấm để xem chi tiết.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );
    return;
  }

  if (!lastDashboard) {
    statusBarItem.text = '$(sync~spin) 9Router...';
    statusBarItem.tooltip = 'Đang tải danh sách providers và usage...';
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const primary = lastDashboard.primary;
  if (!primary) {
    statusBarItem.text = '$(warning) 9Router: chưa có providers';
    statusBarItem.tooltip = createDashboardTooltip(lastDashboard);
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    return;
  }

  const cfg = getConfig();
  const quotaName = chooseQuotaName(primary.usage, cfg.statusBarQuota);
  const quota = quotaName ? primary.usage?.quotas[quotaName] : undefined;
  const remainingPct = quota ? getRemainingPercent(quota) : 0;

  let icon = '$(graph)';
  let bg: vscode.ThemeColor | undefined;
  if (!primary.usage || primary.error || primary.usage.limitReached) {
    icon = '$(error)';
    bg = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (primary.usage.reviewLimitReached || remainingPct <= 15) {
    icon = '$(warning)';
    bg = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  const quotaLabel = quota
    ? formatQuotaForStatus(quotaName ?? cfg.statusBarQuota, quota)
    : 'không có usage';
  statusBarItem.text = `${icon} priority=1 ${quotaLabel}`;
  statusBarItem.backgroundColor = bg;
  statusBarItem.tooltip = createDashboardTooltip(lastDashboard);
}

function createDashboardTooltip(data: DashboardData): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = true;

  md.appendMarkdown('**9Router Token Usage**\n\n');
  md.appendMarkdown(
    `Cập nhật: \`${formatDate(data.fetchedAt.toISOString())}\`\n\n`
  );
  md.appendMarkdown(
    'Status bar đang hiển thị provider có `priority=1`. Bấm để xem popup đầy đủ.\n\n'
  );
  if (lastError) {
    md.appendMarkdown(`> Lần làm mới gần nhất lỗi: ${lastError}\n\n`);
  }

  for (const item of data.items) {
    const { connection, usage } = item;
    const primaryMark = connection.priority === 1 ? '⭐ ' : '';
    md.appendMarkdown(
      `### ${primaryMark}priority=${connection.priority} — \`${displayName(
        connection
      )}\`\n\n`
    );
    md.appendMarkdown(
      `- Provider: \`${connection.provider}\`${
        connection.authType ? ` · Auth: \`${connection.authType}\`` : ''
      }\n`
    );
    md.appendMarkdown(
      `- Active: \`${connection.isActive}\`${
        connection.testStatus ? ` · Test: \`${connection.testStatus}\`` : ''
      }\n`
    );
    if (usage?.plan || connectionPlan(connection)) {
      md.appendMarkdown(
        `- Plan: \`${usage?.plan ?? connectionPlan(connection)}\`\n`
      );
    }
    if (item.error) {
      md.appendMarkdown(`- Usage error: \`${item.error}\`\n\n`);
      continue;
    }
    if (!usage) {
      md.appendMarkdown('- Chưa có dữ liệu usage.\n\n');
      continue;
    }

    md.appendMarkdown(
      `- Limit reached: \`${usage.limitReached}\` · Review limit: \`${usage.reviewLimitReached}\`\n`
    );
    appendQuotaMarkdown(md, usage);
    if (connection.lastUsedAt) {
      md.appendMarkdown(`- Last used: \`${formatDate(connection.lastUsedAt)}\`\n`);
    }
    if (connection.expiresAt) {
      md.appendMarkdown(`- Expires: \`${formatDate(connection.expiresAt)}\`\n`);
    }
    md.appendMarkdown('\n');
  }

  return md;
}

function appendQuotaMarkdown(md: vscode.MarkdownString, usage: UsageData): void {
  for (const [name, quota] of Object.entries(usage.quotas)) {
    const usedPct = getUsedPercent(quota);
    md.appendMarkdown(
      `- ${quotaTitle(name)}: \`${formatQuotaDetail(quota)}\` (${usedPct.toFixed(
        1
      )}% đã dùng)\n`
    );
    if (!quota.unlimited && quota.total > 0) {
      md.appendMarkdown(`  ${renderBar(usedPct)}\n`);
    }
    if (quota.resetAt) {
      md.appendMarkdown(`  Reset: \`${formatDate(quota.resetAt)}\`\n`);
    }
  }
}

async function showDetails(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  if (!apiKey) {
    const pick = await vscode.window.showWarningMessage(
      'Chưa thiết lập API key.',
      'Thiết lập ngay'
    );
    if (pick) {
      await setApiKey(context);
    }
    return;
  }

  if (!lastDashboard) {
    await refresh(context);
  }

  if (lastError && !lastDashboard) {
    const pick = await vscode.window.showErrorMessage(
      `9Router Token Usage: ${lastError}`,
      'Thử lại',
      'Đổi API key'
    );
    if (pick === 'Thử lại') {
      await refresh(context);
    } else if (pick === 'Đổi API key') {
      await setApiKey(context);
    }
    return;
  }

  if (!lastDashboard) {
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    '9Router Token Usage',
    { modal: true, detail: createDashboardDetails(lastDashboard) },
    'Làm mới',
    'Đổi API key'
  );
  if (pick === 'Làm mới') {
    await refresh(context);
  } else if (pick === 'Đổi API key') {
    await setApiKey(context);
  }
}

function createDashboardDetails(data: DashboardData): string {
  const lines: string[] = [
    `Cập nhật: ${formatDate(data.fetchedAt.toISOString())}`,
    'Status bar đang hiển thị provider có priority=1.',
    ''
  ];

  if (lastError) {
    lines.push(`Lỗi lần làm mới gần nhất: ${lastError}`, '');
  }

  for (const item of data.items) {
    const { connection, usage } = item;
    lines.push(
      `[priority=${connection.priority}] ${displayName(connection)}`,
      `ID: ${connection.id}`,
      `Provider: ${connection.provider}${
        connection.authType ? ` | Auth: ${connection.authType}` : ''
      }`,
      `Active: ${connection.isActive}${
        connection.testStatus ? ` | Test: ${connection.testStatus}` : ''
      }`
    );

    if (usage?.plan || connectionPlan(connection)) {
      lines.push(`Plan: ${usage?.plan ?? connectionPlan(connection)}`);
    }
    if (connection.lastUsedAt) {
      lines.push(`Last used: ${formatDate(connection.lastUsedAt)}`);
    }
    if (connection.lastRefreshAt) {
      lines.push(`Last refresh: ${formatDate(connection.lastRefreshAt)}`);
    }
    if (connection.expiresAt) {
      lines.push(`Expires: ${formatDate(connection.expiresAt)}`);
    }

    if (item.error) {
      lines.push(`Usage error: ${item.error}`, '');
      continue;
    }
    if (!usage) {
      lines.push('Usage: chưa có dữ liệu', '');
      continue;
    }

    lines.push(
      `Limit reached: ${usage.limitReached} | Review limit: ${usage.reviewLimitReached}`
    );
    for (const [name, quota] of Object.entries(usage.quotas)) {
      lines.push(`${quotaTitle(name)}: ${formatQuotaDetail(quota)}`);
      if (quota.resetAt) {
        lines.push(`  Reset: ${formatDate(quota.resetAt)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function chooseQuotaName(
  usage: UsageData | undefined,
  preferred: string
): string | undefined {
  if (!usage) {
    return undefined;
  }
  if (usage.quotas[preferred]) {
    return preferred;
  }
  if (usage.quotas.session) {
    return 'session';
  }
  if (usage.quotas.weekly) {
    return 'weekly';
  }
  return Object.keys(usage.quotas)[0];
}

function displayName(connection: ProviderConnection): string {
  return connection.name ?? connection.email ?? connection.provider ?? connection.id;
}

function connectionPlan(connection: ProviderConnection): string | undefined {
  return toOptionalString(connection.providerSpecificData.chatgptPlanType);
}

function quotaTitle(name: string): string {
  if (name === 'session') {
    return 'Session';
  }
  if (name === 'weekly') {
    return 'Weekly';
  }
  return name;
}

function quotaShortName(name: string): string {
  if (name === 'session') {
    return 'S';
  }
  if (name === 'weekly') {
    return 'W';
  }
  return name;
}

function formatQuotaForStatus(name: string, quota: QuotaData): string {
  if (quota.unlimited) {
    return `${quotaShortName(name)} ∞`;
  }
  return `${quotaShortName(name)} ${formatCompact(quota.remaining)}/${formatCompact(
    quota.total
  )}`;
}

function formatQuotaDetail(quota: QuotaData): string {
  if (quota.unlimited) {
    return `${quota.used.toLocaleString()} đã dùng / không giới hạn`;
  }
  return `${quota.used.toLocaleString()}/${quota.total.toLocaleString()} đã dùng, còn ${quota.remaining.toLocaleString()} (${getRemainingPercent(
    quota
  ).toFixed(1)}%)`;
}

function getUsedPercent(quota: QuotaData): number {
  if (quota.unlimited || quota.total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (quota.used / quota.total) * 100));
}

function getRemainingPercent(quota: QuotaData): number {
  if (quota.unlimited) {
    return 100;
  }
  if (quota.total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (quota.remaining / quota.total) * 100));
}

function renderBar(pct: number, width = 28): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let color = '#3fb950';
  if (clamped >= 95) {
    color = '#f85149';
  } else if (clamped >= 85) {
    color = '#d29922';
  }

  const unit = '&nbsp;';
  const filledBar =
    filled > 0
      ? `<span style="background-color:${color};">${unit.repeat(filled)}</span>`
      : '';
  const emptyBar =
    empty > 0
      ? `<span style="background-color:#3a3f47;">${unit.repeat(empty)}</span>`
      : '';
  return filledBar + emptyBar;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1).replace(/\.?0+$/, '') + 'K';
  }
  return String(n);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}
