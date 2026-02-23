// ── Form validation ─────────────────────────────────────────────────────────
document.addEventListener("submit", function (e) {
  var form = e.target;
  if (!form.hasAttribute("data-frs-form")) return;
  form.querySelectorAll("textarea[data-json]").forEach(function (ta) {
    var v = ta.value.trim();
    if (!v) return;
    try {
      JSON.parse(v);
    } catch (err) {
      e.preventDefault();
      alert('Invalid JSON in field "' + ta.name + '":\n' + err.message);
    }
  });
});

// ── Table enhancements (resize + column visibility) ─────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("table[data-frs-table]").forEach(initTable);
});

function initTable(table) {
  initColumnResize(table);
  initColumnVisibility(table);
}

// ── Column resize ────────────────────────────────────────────────────────────
function initColumnResize(table) {
  var ths = Array.from(table.querySelectorAll("thead th"));
  ths.forEach(function (th, i) {
    if (i === ths.length - 1) return;
    th.style.position = "relative";
    th.style.userSelect = "none";
    var handle = document.createElement("div");
    handle.style.cssText =
      "position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;z-index:10;background:transparent;";
    handle.addEventListener("mouseenter", function () {
      handle.style.background = "rgba(99,102,241,0.35)";
    });
    handle.addEventListener("mouseleave", function () {
      if (!handle._drag) handle.style.background = "transparent";
    });
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      handle._drag = true;
      var startX = e.clientX,
        startW = th.offsetWidth;
      var line = document.createElement("div");
      line.style.cssText =
        "position:fixed;top:0;bottom:0;width:2px;background:#6366f1;opacity:0.6;pointer-events:none;z-index:9999;";
      line.style.left = e.clientX + "px";
      document.body.appendChild(line);
      function onMove(ev) {
        var newW = Math.max(40, startW + ev.clientX - startX);
        th.style.width = newW + "px";
        th.style.minWidth = newW + "px";
        line.style.left = ev.clientX + "px";
      }
      function onUp() {
        handle._drag = false;
        handle.style.background = "transparent";
        document.body.removeChild(line);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    th.appendChild(handle);
  });
}

// ── Column visibility ────────────────────────────────────────────────────────
function initColumnVisibility(table) {
  var ths = Array.from(table.querySelectorAll("thead th"));
  var cols = ths.slice(0, ths.length - 1).map(function (th, i) {
    return { index: i, label: th.textContent.replace(/\s+/g, " ").trim() };
  });
  if (cols.length === 0) return;
  var wrap = table.closest("[data-frs-table-wrap]");
  var toolbar = wrap && wrap.previousElementSibling;
  if (!toolbar) return;
  var repo = table.getAttribute("data-frs-repo") || "default";
  var storageKey = "frs_cols_" + repo;
  var savedState = {};
  try {
    savedState = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch (_) {}
  function saveState(index, visible) {
    savedState[index] = visible;
    try {
      localStorage.setItem(storageKey, JSON.stringify(savedState));
    } catch (_) {}
  }
  function setColVisible(ci, visible) {
    ths[ci].style.display = visible ? "" : "none";
    table.querySelectorAll("tbody tr").forEach(function (row) {
      var td = row.querySelectorAll("td")[ci];
      if (td) td.style.display = visible ? "" : "none";
    });
  }
  var dropdown = document.createElement("div");
  dropdown.className = "dropdown dropdown-end";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.tabIndex = 0;
  btn.className = "btn btn-sm btn-outline gap-1";
  btn.title = "Toggle columns";
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg> Columns';
  dropdown.appendChild(btn);
  var menu = document.createElement("ul");
  menu.tabIndex = 0;
  menu.className =
    "dropdown-content menu bg-base-100 rounded-box z-50 p-2 shadow border border-base-300 min-w-44 max-h-72 overflow-y-auto flex-nowrap";
  cols.forEach(function (col) {
    var li = document.createElement("li");
    var label = document.createElement("label");
    label.className =
      "flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-base-200";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checkbox checkbox-xs checkbox-primary";
    var isVisible = savedState[col.index] !== false;
    cb.checked = isVisible;
    cb.setAttribute("data-col", col.index);
    var span = document.createElement("span");
    span.className = "text-sm";
    span.textContent = col.label || "Col " + (col.index + 1);
    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
    if (!isVisible) setColVisible(col.index, false);
    cb.addEventListener("change", function (e) {
      var visible = e.target.checked;
      setColVisible(col.index, visible);
      saveState(col.index, visible);
    });
    menu.appendChild(li);
  });
  dropdown.appendChild(menu);
  toolbar.appendChild(dropdown);
}
