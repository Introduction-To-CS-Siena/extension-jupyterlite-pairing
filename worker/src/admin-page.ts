/**
 * The admin dashboard, served as one self-contained document.
 *
 * Inline styles and script only — no CDN, no build step for the Worker, and
 * nothing to keep in sync with the JSON API beyond this file.
 */

export function adminPage(signedInAs: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pairing sessions</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #d8dce2;
    --text: #1c2024;
    --muted: #666f7a;
    --accent: #2f6feb;
    --live: #1a7f4b;
    --live-bg: #e3f5ea;
    --ended: #6b7280;
    --ended-bg: #eceef1;
    --danger: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a;
      --panel: #1c2024;
      --border: #303740;
      --text: #e6e8eb;
      --muted: #9aa4b0;
      --accent: #6a9bff;
      --live: #6ee7a8;
      --live-bg: #14321f;
      --ended: #9aa4b0;
      --ended-bg: #23282e;
      --danger: #ff8b82;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.5rem;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .bar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; }
  button {
    font: inherit;
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.danger { color: var(--danger); }
  .table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; min-width: 46rem; }
  th, td { text-align: left; padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem; }
  .code-cell { cursor: pointer; user-select: none; }
  .code-cell:hover { color: var(--accent); }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.live { background: var(--live-bg); color: var(--live); }
  .badge.ended { background: var(--ended-bg); color: var(--ended); }
  .empty, .error { padding: 2rem; text-align: center; color: var(--muted); }
  .error { color: var(--danger); }
  dialog {
    border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text);
    max-width: min(52rem, 92vw); width: 52rem; padding: 0;
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
  .dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 0.9rem 1rem; border-bottom: 1px solid var(--border); }
  .dialog-body { padding: 1rem; max-height: 65vh; overflow: auto; }
  .cell { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.6rem; }
  .cell-kind { padding: 0.25rem 0.6rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border-bottom: 1px solid var(--border); }
  .cell pre { margin: 0; padding: 0.6rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Pairing sessions</h1>
    <span class="meta">Signed in as <strong id="who"></strong></span>
  </header>
  <div class="bar">
    <button id="refresh">Refresh</button>
    <span class="meta" id="status">Loading…</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Code</th><th>Status</th><th>In room</th>
          <th>Created</th><th>Expires</th><th>Last activity</th><th></th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>No pairing sessions recorded.</div>
    <div class="error" id="error" hidden></div>
  </div>
</main>

<dialog id="preview">
  <div class="dialog-head">
    <strong id="preview-title">Notebook preview</strong>
    <button id="preview-close">Close</button>
  </div>
  <div class="dialog-body" id="preview-body"></div>
</dialog>

<script>
(function () {
  var REFRESH_MS = 30000;
  var revealed = Object.create(null);
  var timer = null;

  document.getElementById('who').textContent = ${JSON.stringify(signedInAs)};

  function relative(ms) {
    if (ms === null || ms === undefined) return '—';
    var delta = ms - Date.now();
    var future = delta > 0;
    var seconds = Math.floor(Math.abs(delta) / 1000);
    var text;
    if (seconds < 60) text = seconds + 's';
    else if (seconds < 3600) text = Math.floor(seconds / 60) + 'm';
    else if (seconds < 86400) text = Math.floor(seconds / 3600) + 'h';
    else text = Math.floor(seconds / 86400) + 'd';
    return future ? 'in ' + text : text + ' ago';
  }

  function mask(code) {
    return revealed[code] ? code : code.slice(0, 5) + '-' + '\\u2022\\u2022\\u2022\\u2022\\u2022';
  }

  function cell(text) {
    var td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function render(rooms) {
    var tbody = document.getElementById('rows');
    tbody.textContent = '';
    document.getElementById('empty').hidden = rooms.length > 0;

    rooms.forEach(function (room) {
      var tr = document.createElement('tr');

      var codeTd = document.createElement('td');
      var codeEl = document.createElement('code');
      codeEl.className = 'code-cell';
      codeEl.textContent = mask(room.code);
      codeEl.title = revealed[room.code] ? 'Click to hide' : 'Click to reveal the joinable code';
      codeEl.addEventListener('click', function () {
        revealed[room.code] = !revealed[room.code];
        codeEl.textContent = mask(room.code);
        codeEl.title = revealed[room.code] ? 'Click to hide' : 'Click to reveal the joinable code';
      });
      codeTd.appendChild(codeEl);
      tr.appendChild(codeTd);

      var statusTd = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + (room.live ? 'live' : 'ended');
      badge.textContent = room.live ? 'Live' : 'Ended';
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      tr.appendChild(cell(room.live ? String(room.participants) : '—'));
      tr.appendChild(cell(relative(room.createdAt)));
      tr.appendChild(cell(room.live ? relative(room.expiresAt) : '—'));
      tr.appendChild(cell(relative(room.lastSeenAt)));

      var actions = document.createElement('td');
      var inspect = document.createElement('button');
      inspect.textContent = 'Inspect';
      inspect.disabled = !room.live;
      inspect.addEventListener('click', function () { openPreview(room.code); });
      actions.appendChild(inspect);

      if (room.live) {
        var end = document.createElement('button');
        end.textContent = 'End';
        end.className = 'danger';
        end.style.marginLeft = '0.4rem';
        end.addEventListener('click', function () { endRoom(room.code); });
        actions.appendChild(end);
      }
      tr.appendChild(actions);

      tbody.appendChild(tr);
    });
  }

  function load() {
    return fetch('/admin/api/rooms', { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Request failed (' + response.status + ')');
        return response.json();
      })
      .then(function (data) {
        document.getElementById('error').hidden = true;
        render(data.rooms || []);
        document.getElementById('status').textContent =
          'Updated ' + new Date().toLocaleTimeString() + ' · ' + (data.rooms || []).length + ' recorded';
      })
      .catch(function (error) {
        var box = document.getElementById('error');
        box.hidden = false;
        box.textContent = 'Could not load sessions: ' + error.message;
        document.getElementById('status').textContent = 'Update failed';
      });
  }

  function endRoom(code) {
    if (!confirm('End pairing session ' + code + '? Everyone in it is disconnected immediately.')) return;
    fetch('/admin/api/rooms/' + code + '/end', { method: 'POST' })
      .then(function (response) {
        if (!response.ok) throw new Error('Request failed (' + response.status + ')');
        return load();
      })
      .catch(function (error) { alert('Could not end the session: ' + error.message); });
  }

  function openPreview(code) {
    var dialog = document.getElementById('preview');
    var body = document.getElementById('preview-body');
    document.getElementById('preview-title').textContent = 'Notebook preview · ' + code;
    body.textContent = 'Loading…';
    dialog.showModal();

    fetch('/admin/api/rooms/' + code + '/inspect')
      .then(function (response) {
        if (!response.ok) throw new Error('Request failed (' + response.status + ')');
        return response.json();
      })
      .then(function (data) {
        body.textContent = '';
        if (data.error) { body.textContent = data.error; return; }
        if (!data.cells || !data.cells.length) { body.textContent = 'This notebook is empty.'; return; }
        data.cells.forEach(function (item) {
          var wrap = document.createElement('div');
          wrap.className = 'cell';
          var kind = document.createElement('div');
          kind.className = 'cell-kind';
          kind.textContent = item.cellType;
          var pre = document.createElement('pre');
          pre.textContent = item.source;
          wrap.appendChild(kind);
          wrap.appendChild(pre);
          body.appendChild(wrap);
        });
        if (data.truncated) {
          var note = document.createElement('div');
          note.className = 'meta';
          note.textContent = 'Preview truncated.';
          body.appendChild(note);
        }
      })
      .catch(function (error) { body.textContent = 'Could not load the preview: ' + error.message; });
  }

  document.getElementById('preview-close').addEventListener('click', function () {
    document.getElementById('preview').close();
  });
  document.getElementById('refresh').addEventListener('click', load);

  // Polling stops entirely while the tab is hidden: a dashboard left open in a
  // background tab should not keep billing queries all day.
  function schedule() {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(load, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer !== null) { clearInterval(timer); timer = null; }
    } else {
      load();
      schedule();
    }
  });

  load();
  schedule();
})();
</script>
</body>
</html>`;
}
