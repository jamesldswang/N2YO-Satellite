// Claude Code SessionStart hook（.claude/settings.json）：開專案時先和 GitHub 對齊，避免在不同電腦用舊版開發。
// - 落後、本機沒有未 commit 的修改、也沒有還沒 push 的 commit → 自動 git pull --ff-only（只會往前跟上，不會合併）
// - 其他情況（有未 commit 的修改、和遠端分岔、沒網路）→ 不動檔案，只提醒
// 輸出 Claude Code hook 的 JSON：systemMessage 給使用者看，additionalContext 給 Claude 看。
const { execFileSync } = require('node:child_process');

const git = (...args) => execFileSync('git', args, { cwd: __dirname + '/..', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const out = (msg) => {
  console.log(JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `【Git 同步檢查】${msg}` },
  }));
};

try {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  try {
    git('fetch', '--quiet', 'origin');
  } catch {
    out(`無法連到 GitHub（git fetch 失敗），不確定 ${branch} 是不是最新版，開發前請先確認。`);
    process.exit(0);
  }
  const upstream = `origin/${branch}`;
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `${upstream}...HEAD`).split(/\s+/).map(Number);
  const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
  const head = () => git('log', '-1', '--format=%h %s');

  if (!behind && !ahead) {
    out(`${branch} 和 GitHub 一致（${head()}）${dirty ? '，本機有未 commit 的修改' : ''}。`);
  } else if (behind && !ahead && !dirty) {
    git('pull', '--ff-only', '--quiet');
    out(`本機落後 GitHub ${behind} 個 commit，已自動 pull，現在是 ${head()}。`);
  } else if (behind && ahead) {
    out(`⚠ 本機和 GitHub 分岔了（本機多 ${ahead}、GitHub 多 ${behind} 個 commit），沒有自動 pull，請先處理再開發。`);
  } else if (behind) {
    out(`⚠ 本機落後 GitHub ${behind} 個 commit，但有未 commit 的修改，沒有自動 pull；請先 commit 或 stash 再 pull。`);
  } else {
    out(`本機比 GitHub 多 ${ahead} 個 commit 還沒 push${dirty ? '，也有未 commit 的修改' : ''}；換電腦前記得 push。`);
  }
} catch (err) {
  out(`Git 同步檢查失敗：${String(err.message).split('\n')[0]}`);
}
