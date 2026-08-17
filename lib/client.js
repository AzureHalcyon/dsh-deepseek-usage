// dsh-deepseek-usage — client half (hand-written bundle; no build step needed).
// `react` is a platform seed module. Credentials NEVER live in the browser:
// the host reads the API Key from the DSH credentials service and the platform
// userToken from ~/.dsh/ds-balance.json; the browser only sees masked values.
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-usage',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var R = {
      status: '/deepseek-usage/status',
      balance: '/deepseek-usage/balance',
      usage: '/deepseek-usage/usage',
      token: '/deepseek-usage/token',
      keys: '/deepseek-usage/keys',
    };
    var LOW_BALANCE_THRESHOLD = 5;
    var AUTO_KEY = 'dsh-deepseek-usage.autoRefresh';

    var CODE_TEXT = {
      missing_api_key: '未配置 DeepSeek API Key',
      missing_token: '未配置 userToken',
      auth_failed: '凭据无效或已过期',
      timeout: '请求超时',
      fetch_failed: '网络请求失败',
      invalid_response: '接口返回异常',
      forbidden: '拒绝访问',
      method_not_allowed: '方法不允许',
      network: '网络错误',
    };
    function codeText(code) { return CODE_TEXT[code] || null; }

    var DOT_COLORS = { green: 'rgb(34,197,94)', yellow: 'rgb(234,179,8)', red: 'rgb(239,68,68)', gray: 'rgb(148,163,184)' };
    var TONE_TEXT = { green: '可用', yellow: '余额偏低', red: '不可用', gray: '未配置' };

    var s = {
      wrap: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: 560 },
      titleRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      dot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
      note: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #888)' },
      section: { display: 'flex', flexDirection: 'column', gap: '8px' },
      sectionLabel: { fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--dsw-alias-label-secondary, #888)' },
      keyLine: { display: 'flex', alignItems: 'center', gap: '10px' },
      masked: { fontFamily: 'monospace', fontSize: '13px', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary, inherit)' },
      keyInputRow: { display: 'flex', gap: '8px' },
      input: { flex: 1, padding: '8px 10px', fontSize: '13px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' },
      option: { background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #000)' },
      btn: { padding: '8px 14px', fontSize: '13px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer' },
      btnPrimary: { padding: '8px 16px', fontSize: '13px', fontWeight: 600, borderRadius: 6, border: 'none', background: 'rgb(59,130,246)', color: '#fff', cursor: 'pointer' },
      btnGhost: { padding: '4px 10px', fontSize: '12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer' },
      controls: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' },
      autoLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
      checkbox: { cursor: 'pointer' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #888)' },
      error: { padding: '8px 12px', borderRadius: 6, fontSize: '12px', background: 'rgba(239,68,68,0.12)', color: 'var(--dsw-alias-state-error-primary, rgb(220,38,38))', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      card: { padding: '12px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #ccc)' },
      cardLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #888)', marginBottom: '6px' },
      cardBig: { fontSize: '20px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--dsw-alias-label-primary, inherit)' },
      cardSub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #888)', marginTop: '6px', wordBreak: 'break-word' },
      breakRow: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', marginTop: '6px' },
    };

    function currencySymbol(c) { return c === 'USD' ? '$' : c === 'CNY' ? '¥' : c + ' '; }
    function fmtTokens(n) { return Number(n || 0).toLocaleString(); }
    function fmtCost(v) {
      var n = Number(v);
      if (isNaN(n)) return '0';
      var t = n.toFixed(4);
      t = t.replace(/0+$/, '').replace(/\.$/, '');
      return t;
    }
    function fmtTime(ts) {
      if (!ts) return '—';
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleTimeString();
    }

    function toneOf(balance) {
      if (!balance) return 'gray';
      if (balance.is_available === false) return 'red';
      var minTotal = Infinity;
      (balance.balance_infos || []).forEach(function (info) {
        var v = Number(info.total_balance);
        if (!isNaN(v) && v < minTotal) minTotal = v;
      });
      if (minTotal !== Infinity && minTotal <= LOW_BALANCE_THRESHOLD) return 'yellow';
      return 'green';
    }

    function call(path, opts) {
      return fetch(path, opts)
        .then(function (r) { return r.json(); })
        .catch(function (e) { return { ok: false, code: 'network', message: String((e && e.message) || e) }; });
    }

    function errText(r) {
      return (r && r.message) || codeText(r && r.code) || '操作失败';
    }

    function DeepSeekBalance(props) {
      var tokenInputState = React.useState(''); var tokenInput = tokenInputState[0], setTokenInput = tokenInputState[1];
      var maskedKeyState = React.useState(''); var maskedKey = maskedKeyState[0], setMaskedKey = maskedKeyState[1];
      var maskedTokenState = React.useState(''); var maskedToken = maskedTokenState[0], setMaskedToken = maskedTokenState[1];
      var tokenSourceState = React.useState(''); var tokenSource = tokenSourceState[0], setTokenSource = tokenSourceState[1];
      var keysState = React.useState([]); var keys = keysState[0], setKeys = keysState[1];
      var selectedKeyState = React.useState(''); var selectedKey = selectedKeyState[0], setSelectedKey = selectedKeyState[1];
      var hasKeyState = React.useState(false); var hasKey = hasKeyState[0], setHasKey = hasKeyState[1];
      var hasTokenState = React.useState(false); var hasToken = hasTokenState[0], setHasToken = hasTokenState[1];
      var balanceState = React.useState(null); var balance = balanceState[0], setBalance = balanceState[1];
      var usageState = React.useState(null); var usage = usageState[0], setUsage = usageState[1];
      var balanceErrState = React.useState(''); var balanceErr = balanceErrState[0], setBalanceErr = balanceErrState[1];
      var usageErrState = React.useState(''); var usageErr = usageErrState[0], setUsageErr = usageErrState[1];
      var errorState = React.useState(''); var error = errorState[0], setError = errorState[1];
      var loadingState = React.useState(false); var loading = loadingState[0], setLoading = loadingState[1];
      var lastSyncState = React.useState(null); var lastSync = lastSyncState[0], setLastSync = lastSyncState[1];
      var autoState = React.useState(function () { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { return false; } }); var auto = autoState[0], setAuto = autoState[1];

      function syncBoth(keySet, tokenSet, keyFilter) {
        setLoading(true);
        setError('');
        setBalanceErr('');
        setUsageErr('');
        var balanceDone = keySet
          ? call(R.balance).then(function (r) {
              if (r && r.ok) { setBalance(r.data); setLastSync(new Date().toISOString()); }
              else setBalanceErr(errText(r));
            })
          : Promise.resolve();
        var kf = keyFilter !== undefined ? keyFilter : selectedKey;
        var usagePath = R.usage + (kf ? ('?key=' + encodeURIComponent(kf)) : '');
        var usageDone = tokenSet
          ? call(usagePath).then(function (r) {
              if (r && r.ok) { setUsage(r.data); setLastSync(new Date().toISOString()); }
              else setUsageErr(errText(r));
            })
          : Promise.resolve();
        Promise.all([balanceDone, usageDone]).finally(function () { setLoading(false); });
      }

      React.useEffect(function () {
        var alive = true;
        loadKeys();
        call(R.status).then(function (r) {
          if (!alive) return;
          if (r && r.ok) {
            var keySet = !!r.hasKey;
            var tokenSet = !!r.hasToken;
            setHasKey(keySet);
            setHasToken(tokenSet);
            setMaskedKey(r.maskedKey || '');
            setMaskedToken(r.maskedToken || '');
            setTokenSource(r.tokenSource || '');
            if (keySet || tokenSet) syncBoth(keySet, tokenSet);
          }
        });
        return function () { alive = false; };
      }, []);

      React.useEffect(function () {
        if (!auto) return;
        var timer = props.ctx.get('timer');
        if (timer === undefined) return;
        return timer.interval(function () { syncBoth(hasKey, hasToken); }, 60000);
      }, [auto, hasKey, hasToken, selectedKey]);

      function loadKeys() {
        call(R.keys).then(function (r) {
          if (r && r.ok) setKeys(r.keys || []);
        });
      }

      function refreshTokenStatus() {
        call(R.status).then(function (r) {
          if (r && r.ok) {
            setHasToken(!!r.hasToken);
            setMaskedToken(r.maskedToken || '');
            setTokenSource(r.tokenSource || '');
            if (r.hasToken) syncBoth(hasKey, true);
          } else {
            setHasToken(false);
            setMaskedToken('');
            setTokenSource('');
          }
        });
      }

      function saveToken() {
        var t = tokenInput.trim();
        setError('');
        if (!t) return;
        call(R.token, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) }).then(function (r) {
          if (r && r.ok) {
            setTokenInput('');
            refreshTokenStatus();
          } else {
            setError(errText(r));
          }
        });
      }

      function clearToken() {
        call(R.token, { method: 'DELETE' }).then(function () {
          setTokenInput('');
          setUsage(null);
          setUsageErr('');
          refreshTokenStatus();
        });
      }

      var tone = toneOf(balance);
      var dot = React.createElement('span', { style: Object.assign({}, s.dot, { background: DOT_COLORS[tone] }) });

      var balanceCards = [];
      if (balance && Array.isArray(balance.balance_infos)) {
        balance.balance_infos.forEach(function (info) {
          balanceCards.push(
            React.createElement('div', { key: info.currency, style: s.card },
              React.createElement('div', { style: s.cardLabel }, '账户余额 · ' + info.currency),
              React.createElement('div', { style: s.cardBig }, currencySymbol(info.currency) + info.total_balance),
              React.createElement('div', { style: s.cardSub }, '充值 ' + info.topped_up_balance + ' · 赠送 ' + info.granted_balance),
            ),
          );
        });
      }

      var usageCards = [];
      if (usage) {
        usageCards.push(
          React.createElement('div', { key: 'cost', style: s.card },
            React.createElement('div', { style: s.cardLabel }, '今日消费'),
            React.createElement('div', { style: s.cardBig }, currencySymbol(usage.currency) + fmtCost(usage.today.cost)),
            React.createElement('div', { style: s.cardSub }, '本月 ' + currencySymbol(usage.currency) + fmtCost(usage.month.cost)),
            React.createElement('div', { style: s.cardSub }, '总消费 ' + (usage.totalCost != null ? currencySymbol(usage.currency) + fmtCost(usage.totalCost) : '—')),
          ),
          React.createElement('div', { key: 'tokens', style: s.card },
            React.createElement('div', { style: s.cardLabel }, '今日 Token'),
            React.createElement('div', { style: s.cardBig }, fmtTokens(usage.today.tokens)),
            React.createElement('div', { style: s.cardSub }, '本月 ' + fmtTokens(usage.month.tokens)),
          ),
          React.createElement('div', { key: 'req', style: s.card },
            React.createElement('div', { style: s.cardLabel }, '今日请求次数'),
            React.createElement('div', { style: s.cardBig }, fmtTokens(usage.today.requests)),
            React.createElement('div', { style: s.cardSub }, '本月 ' + fmtTokens(usage.month.requests) + ' 次'),
          ),
          React.createElement('div', { key: 'break', style: Object.assign({}, s.card, { gridColumn: '1 / -1' }) },
            React.createElement('div', { style: s.cardLabel }, 'Token 构成（本月）'),
            React.createElement('div', { style: s.breakRow },
              React.createElement('span', null, '缓存命中 ' + fmtTokens(usage.breakdown.cacheHit)),
              React.createElement('span', null, '缓存未命中 ' + fmtTokens(usage.breakdown.cacheMiss)),
              React.createElement('span', null, '输出 ' + fmtTokens(usage.breakdown.output)),
            ),
          ),
        );
      }

      return React.createElement('div', { style: s.wrap },
        React.createElement('div', { style: s.titleRow },
          React.createElement('h2', { style: s.title }, 'DeepSeek 用量'),
          dot,
          React.createElement('span', { style: s.note }, TONE_TEXT[tone]),
        ),

        React.createElement('div', { style: s.section },
          React.createElement('div', { style: s.sectionLabel }, 'API Key'),
          React.createElement('div', { style: s.keyLine },
            React.createElement('span', { style: s.masked }, hasKey ? maskedKey : '未配置'),
          ),
          React.createElement('div', { style: s.note }, '同步 DSH 填入的 DeepSeek API Key。'),
        ),

        React.createElement('div', { style: s.section },
          React.createElement('div', { style: s.sectionLabel }, '平台登录态 userToken（查消费/token）'),
          hasToken
            ? React.createElement('div', { style: s.keyLine },
                React.createElement('span', { style: s.note }, '当前：' + maskedToken + (tokenSource === 'auto' ? '（自动读取浏览器）' : '（手动配置）')),
                React.createElement('button', { onClick: clearToken, style: s.btnGhost }, '清除'),
              )
            : React.createElement('div', { style: s.keyInputRow },
                React.createElement('input', { type: 'password', value: tokenInput, placeholder: '手动粘贴 userToken', onChange: function (e) { setTokenInput(e.target.value); }, style: s.input }),
                React.createElement('button', { onClick: saveToken, disabled: !tokenInput.trim(), style: s.btn }, '保存'),
              ),
          React.createElement('div', { style: s.note }, '获取：登录 platform.deepseek.com 后控制台执行 localStorage.getItem("userToken")'),
        ),

        React.createElement('div', { style: s.section },
          React.createElement('div', { style: s.controls },
            React.createElement('button', { onClick: function () { syncBoth(hasKey, hasToken); }, disabled: (!hasKey && !hasToken) || loading, style: s.btnPrimary },
              loading ? '同步中…' : '立即同步'),
            React.createElement('label', { style: s.autoLabel },
              React.createElement('input', { type: 'checkbox', checked: auto, onChange: function (e) { setAuto(e.target.checked); try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ } }, style: s.checkbox }),
              '每 60 秒自动刷新',
            ),
          ),
          React.createElement('div', { style: s.meta }, '上次同步：' + fmtTime(lastSync)),
        ),

        error ? React.createElement('div', { style: s.error }, error) : null,
        balanceErr ? React.createElement('div', { style: s.error }, balanceErr) : null,
        usageErr ? React.createElement('div', { style: s.error }, usageErr) : null,

        balanceCards.length > 0
          ? React.createElement('div', { style: s.section },
              React.createElement('div', { style: s.sectionLabel }, '余额' + (balance && balance.fetchedAt ? '（更新 ' + fmtTime(balance.fetchedAt) + '）' : '')),
              React.createElement('div', { style: s.cards }, balanceCards),
            )
          : null,

        usageCards.length > 0
          ? React.createElement('div', { style: s.section },
              React.createElement('div', { style: s.sectionLabel }, '消费与用量'),
              React.createElement('div', { style: s.keyInputRow },
                React.createElement('select', { value: selectedKey || '', onChange: function (e) { setSelectedKey(e.target.value); syncBoth(hasKey, hasToken, e.target.value); }, style: s.input },
                  React.createElement('option', { value: '', style: s.option }, '全部'),
                  (keys || []).map(function (k) { return React.createElement('option', { key: k, value: k, style: s.option }, k); }),
                ),
              ),
              React.createElement('div', { style: s.cards }, usageCards),
            )
          : null,

        (usage && usage.models && usage.models.length > 0)
          ? React.createElement('div', { style: s.section },
              React.createElement('div', { style: s.sectionLabel }, '模型用量'),
              React.createElement('div', null, usage.models.map(function (m) {
                return React.createElement('div', { key: m.model, style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)', fontSize: '12px' } },
                  React.createElement('span', { style: { fontFamily: 'monospace', color: 'var(--dsw-alias-label-primary, inherit)' } }, m.model),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #888)' } }, fmtTokens(m.tokens) + ' tokens · ' + currencySymbol(usage.currency) + fmtCost(m.cost)),
                );
              })),
            )
          : null,
      );
    }

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'deepseek-usage', order: 25, label: 'DeepSeek 用量' },
          function () { return React.createElement(DeepSeekBalance, { ctx: ctx }); },
        );
      });
    }

    exports.inject = ['slots', 'timer'];
    exports.apply = apply;
    return module.exports;
  },
});
