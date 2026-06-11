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
let detailsPanel: vscode.WebviewPanel | undefined;

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
    : 'N/A';
  const provName = truncateName(displayName(primary.connection), 12);
  statusBarItem.text = `${icon} ${provName} · ${quotaLabel}`;
  statusBarItem.backgroundColor = bg;
  statusBarItem.tooltip = createDashboardTooltip(lastDashboard);
}

function createDashboardTooltip(data: DashboardData): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = true;

  // Header
  md.appendMarkdown('### $(graph) 9Router Token Usage\n\n');
  md.appendMarkdown(
    `$(clock) Cập nhật: \`${formatDate(data.fetchedAt.toISOString())}\`\n\n`
  );
  if (lastError) {
    md.appendMarkdown(`> $(warning) Lỗi lần làm mới gần nhất: ${lastError}\n\n`);
  }
  md.appendMarkdown('---\n\n');

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const { connection, usage } = item;
    const isPrimary = connection.priority === 1;
    const nameLabel = displayName(connection);

    // Provider header with priority badge
    if (isPrimary) {
      md.appendMarkdown(`### ⭐ ${nameLabel}\n\n`);
    } else {
      md.appendMarkdown(`### $(account) ${nameLabel}\n\n`);
    }

    // Status badges row
    const plan = usage?.plan ?? connectionPlan(connection);
    const badges: string[] = [];
    badges.push(`\`#${connection.priority}\``);
    badges.push(`\`${connection.provider}\``);
    if (connection.authType) {
      badges.push(`\`${connection.authType}\``);
    }
    if (plan) {
      badges.push(`\`${plan}\``);
    }
    // Active/test status
    if (connection.isActive && connection.testStatus === 'active') {
      badges.push('`✓ active`');
    } else if (connection.isActive) {
      badges.push(`\`active\``);
    } else {
      badges.push('`✗ inactive`');
    }
    md.appendMarkdown(badges.join(' · ') + '\n\n');

    // Error or no data
    if (item.error) {
      md.appendMarkdown(`$(error) Lỗi: \`${item.error}\`\n\n`);
      if (i < data.items.length - 1) {
        md.appendMarkdown('---\n\n');
      }
      continue;
    }
    if (!usage) {
      md.appendMarkdown('$(info) Chưa có dữ liệu usage.\n\n');
      if (i < data.items.length - 1) {
        md.appendMarkdown('---\n\n');
      }
      continue;
    }

    // Limit warnings
    if (usage.limitReached) {
      md.appendMarkdown('$(error) **Đã hết limit!**\n\n');
    }
    if (usage.reviewLimitReached) {
      md.appendMarkdown('$(warning) **Đã hết review limit!**\n\n');
    }

    // Quotas
    appendQuotaMarkdown(md, usage);

    // Timestamps
    const timestamps: string[] = [];
    if (connection.lastUsedAt) {
      timestamps.push(`$(history) Dùng lần cuối: \`${formatDate(connection.lastUsedAt)}\``);
    }
    if (connection.expiresAt) {
      timestamps.push(`$(calendar) Hết hạn: \`${formatDate(connection.expiresAt)}\``);
    }
    if (timestamps.length > 0) {
      md.appendMarkdown(timestamps.join(' &nbsp;│&nbsp; ') + '\n\n');
    }

    // Separator between providers
    if (i < data.items.length - 1) {
      md.appendMarkdown('---\n\n');
    }
  }

  // Footer
  md.appendMarkdown('\n\n$(info) Bấm để xem chi tiết đầy đủ.\n');

  return md;
}

function appendQuotaMarkdown(md: vscode.MarkdownString, usage: UsageData): void {
  for (const [name, quota] of Object.entries(usage.quotas)) {
    const usedPct = getUsedPercent(quota);
    const quotaIcon = name === 'session' ? '$(pulse)' : '$(calendar)';

    // Quota header with name and percentage
    md.appendMarkdown(
      `${quotaIcon} **${quotaTitle(name)}** — \`${quota.used}\`/\`${quota.total}\` đã dùng (\`${usedPct.toFixed(1)}%\`)\n\n`
    );

    // Progress bar
    if (!quota.unlimited && quota.total > 0) {
      md.appendMarkdown(`${renderBar(usedPct)}\n\n`);
    }

    // Reset time
    if (quota.resetAt) {
      md.appendMarkdown(`$(sync) Reset: \`${formatDate(quota.resetAt)}\`\n\n`);
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

  if (detailsPanel) {
    detailsPanel.webview.html = getWebviewContent(lastDashboard);
    detailsPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  detailsPanel = vscode.window.createWebviewPanel(
    'aiTokenUsage.dashboard',
    '9Router Token Usage',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  detailsPanel.webview.html = getWebviewContent(lastDashboard);

  detailsPanel.webview.onDidReceiveMessage(
    async (msg: { command: string }) => {
      if (msg.command === 'refresh') {
        await refresh(context);
        if (lastDashboard && detailsPanel) {
          detailsPanel.webview.html = getWebviewContent(lastDashboard);
        }
      } else if (msg.command === 'changeApiKey') {
        await setApiKey(context);
      }
    },
    undefined,
    context.subscriptions
  );

  detailsPanel.onDidDispose(
    () => {
      detailsPanel = undefined;
    },
    undefined,
    context.subscriptions
  );
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getWebviewContent(data: DashboardData): string {
  let cardsHtml = '';

  for (const item of data.items) {
    const { connection, usage } = item;
    const isPrimary = connection.priority === 1;
    const nameLabel = escHtml(displayName(connection));
    const plan = usage?.plan ?? connectionPlan(connection);

    // Badges
    let badgesHtml = `<span class="badge priority">#${connection.priority}</span>`;
    badgesHtml += `<span class="badge">${escHtml(connection.provider)}</span>`;
    if (connection.authType) {
      badgesHtml += `<span class="badge">${escHtml(connection.authType)}</span>`;
    }
    if (plan) {
      badgesHtml += `<span class="badge plan">${escHtml(plan)}</span>`;
    }
    if (connection.isActive && connection.testStatus === 'active') {
      badgesHtml += '<span class="badge active">✓ Active</span>';
    } else if (connection.isActive) {
      badgesHtml += '<span class="badge active">Active</span>';
    } else {
      badgesHtml += '<span class="badge inactive">✗ Inactive</span>';
    }

    // Quotas
    let quotasHtml = '';
    if (item.error) {
      quotasHtml = `<div class="error-msg">⚠ ${escHtml(item.error)}</div>`;
    } else if (!usage) {
      quotasHtml = '<div class="no-data">Chưa có dữ liệu usage</div>';
    } else {
      // Limit warnings
      if (usage.limitReached) {
        quotasHtml += '<div class="limit-alert limit">🔴 ĐÃ HẾT LIMIT!</div>';
      }
      if (usage.reviewLimitReached) {
        quotasHtml += '<div class="limit-alert review">🟡 Đã hết review limit</div>';
      }

      for (const [name, quota] of Object.entries(usage.quotas)) {
        const usedPct = getUsedPercent(quota);
        let barColor = 'var(--green)';
        if (usedPct >= 95) { barColor = 'var(--red)'; }
        else if (usedPct >= 85) { barColor = 'var(--yellow)'; }

        const resetHtml = quota.resetAt
          ? `<div class="reset-time">🔄 Reset: ${escHtml(formatDate(quota.resetAt))}</div>`
          : '';

        quotasHtml += `
          <div class="quota-block">
            <div class="quota-header">
              <span class="quota-name">${quotaTitle(name)}</span>
              <span class="quota-nums">${quota.used} / ${quota.total}</span>
              <span class="quota-pct">${usedPct.toFixed(1)}%</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${usedPct}%;background:${barColor}"></div>
            </div>
            ${resetHtml}
          </div>`;
      }
    }

    // Timestamps
    let tsHtml = '';
    const tsItems: string[] = [];
    if (connection.lastUsedAt) {
      tsItems.push(`<span>🕐 Dùng lần cuối: <strong>${escHtml(formatDate(connection.lastUsedAt))}</strong></span>`);
    }
    if (connection.lastRefreshAt) {
      tsItems.push(`<span>🔄 Refresh: <strong>${escHtml(formatDate(connection.lastRefreshAt))}</strong></span>`);
    }
    if (connection.expiresAt) {
      tsItems.push(`<span>📅 Hết hạn: <strong>${escHtml(formatDate(connection.expiresAt))}</strong></span>`);
    }
    if (tsItems.length > 0) {
      tsHtml = `<div class="timestamps">${tsItems.join('<span class="ts-sep">│</span>')}</div>`;
    }

    cardsHtml += `
      <div class="card${isPrimary ? ' primary' : ''}">
        <div class="card-header">
          <div class="card-title">
            <span class="star">${isPrimary ? '⭐' : '👤'}</span>
            <span class="name">${nameLabel}</span>
          </div>
          <div class="badges">${badgesHtml}</div>
        </div>
        <div class="card-body">
          ${quotasHtml}
        </div>
        ${tsHtml}
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: #0d1117;
    --card-bg: #161b22;
    --card-border: #30363d;
    --card-primary-border: #1f6feb;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --blue: #58a6ff;
    --track: #21262d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    padding: 20px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--card-border);
  }
  .header-left h1 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header-left h1 .logo { font-size: 22px; }
  .header-left .updated {
    color: var(--text-muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .header-actions { display: flex; gap: 8px; }
  .btn {
    border: 1px solid var(--card-border);
    background: var(--card-bg);
    color: var(--text);
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn:hover {
    background: #30363d;
    border-color: #8b949e;
  }
  .btn-primary {
    background: #238636;
    border-color: #2ea043;
  }
  .btn-primary:hover {
    background: #2ea043;
    border-color: #3fb950;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
    transition: border-color 0.15s ease;
  }
  .card:hover { border-color: #484f58; }
  .card.primary { border-color: var(--card-primary-border); }
  .card.primary:hover { border-color: var(--blue); }
  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 14px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
  }
  .card-title .star { font-size: 16px; }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 12px;
    background: #21262d;
    color: var(--text-muted);
    border: 1px solid var(--card-border);
  }
  .badge.priority { color: var(--blue); border-color: #1f4470; background: #0d1f3c; }
  .badge.plan { color: #d2a8ff; border-color: #3d2960; background: #1c1236; }
  .badge.active { color: var(--green); border-color: #1b4721; background: #0d2818; }
  .badge.inactive { color: var(--red); border-color: #5a1e1e; background: #2d1111; }
  .card-body { display: flex; flex-direction: column; gap: 12px; }
  .quota-block { padding: 0; }
  .quota-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .quota-name {
    font-weight: 600;
    font-size: 13px;
    min-width: 64px;
  }
  .quota-nums {
    color: var(--text-muted);
    font-size: 12px;
  }
  .quota-pct {
    margin-left: auto;
    font-weight: 600;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .progress-track {
    width: 100%;
    height: 8px;
    background: var(--track);
    border-radius: 4px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.4s ease;
  }
  .reset-time {
    color: var(--text-muted);
    font-size: 11px;
    margin-top: 4px;
  }
  .timestamps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--card-border);
    color: var(--text-muted);
    font-size: 12px;
  }
  .timestamps strong { color: var(--text); font-weight: 500; }
  .ts-sep { color: #30363d; margin: 0 6px; }
  .error-msg {
    color: var(--red);
    padding: 8px 12px;
    background: #2d1111;
    border: 1px solid #5a1e1e;
    border-radius: 6px;
    font-size: 12px;
  }
  .no-data {
    color: var(--text-muted);
    font-size: 12px;
    font-style: italic;
  }
  .limit-alert {
    padding: 6px 12px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 12px;
  }
  .limit-alert.limit {
    background: #2d1111;
    border: 1px solid #5a1e1e;
    color: var(--red);
  }
  .limit-alert.review {
    background: #2d2200;
    border: 1px solid #5a4400;
    color: var(--yellow);
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1><span class="logo">📊</span> 9Router Token Usage</h1>
      <div class="updated">Cập nhật: ${escHtml(formatDate(data.fetchedAt.toISOString()))}</div>
    </div>
    <div class="header-actions">
      <button class="btn btn-primary" onclick="vscode.postMessage({command:'refresh'})">⟳ Làm mới</button>
      <button class="btn" onclick="vscode.postMessage({command:'changeApiKey'})">🔑 Đổi API Key</button>
    </div>
  </div>
  ${cardsHtml}
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
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

function renderBar(pct: number, width = 40): string {
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

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) {
    return name;
  }
  // For emails, truncate before @
  const atIdx = name.indexOf('@');
  if (atIdx > 0 && atIdx <= maxLen - 1) {
    return name.slice(0, maxLen - 1) + '…';
  }
  return name.slice(0, maxLen - 1) + '…';
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
