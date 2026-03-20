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

// ── Table enhancements ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("table[data-frs-table]").forEach(initTable);
});

function initTable(table) {
  tagOriginalIndices(table);
  applySavedColumnOrder(table);
  initColumnResize(table);
  initColumnVisibility(table);
  initColumnReorder(table);
}

// ── Tag original column indices ─────────────────────────────────────────────
function tagOriginalIndices(table) {
  var ths = Array.from(table.querySelectorAll("thead th"));
  var dataCount = countDataColumns(table, ths);
  for (var i = 0; i < dataCount; i++) {
    ths[i].setAttribute("data-orig-col", String(i));
  }
  table.querySelectorAll("tbody tr").forEach(function (row) {
    var tds = Array.from(row.querySelectorAll("td"));
    for (var j = 0; j < dataCount && j < tds.length; j++) {
      tds[j].setAttribute("data-orig-col", String(j));
    }
  });
}

function countDataColumns(table, ths) {
  var explicit = table.getAttribute("data-frs-colcount");
  if (explicit) return parseInt(explicit, 10);
  var count = 0;
  for (var i = 0; i < ths.length; i++) {
    if (ths[i].querySelector("a[href]")) count++;
    else break;
  }
  return count || Math.max(0, ths.length - 1);
}

// ── Apply saved column order ────────────────────────────────────────────────
function applySavedColumnOrder(table) {
  var repo = table.getAttribute("data-frs-repo") || "default";
  var saved;
  try {
    saved = JSON.parse(localStorage.getItem("frs_colorder_" + repo));
  } catch (_) {
    return;
  }
  if (!saved || !Array.isArray(saved) || saved.length === 0) return;
  reorderColumns(table, saved);
}

// ── Reorder columns by orig-index array ─────────────────────────────────────
function reorderColumns(table, order) {
  var headRow = table.querySelector("thead tr");
  if (!headRow) return;
  reorderRow(headRow, order);
  table.querySelectorAll("tbody tr").forEach(function (row) {
    reorderRow(row, order);
  });
}

function reorderRow(row, order) {
  var cells = Array.from(row.children);
  var dataCells = cells.filter(function (c) {
    return c.hasAttribute("data-orig-col");
  });
  var tailCells = cells.filter(function (c) {
    return !c.hasAttribute("data-orig-col");
  });
  var cellMap = {};
  dataCells.forEach(function (c) {
    cellMap[c.getAttribute("data-orig-col")] = c;
  });
  while (row.firstChild) row.removeChild(row.firstChild);
  order.forEach(function (origIdx) {
    if (cellMap[origIdx]) row.appendChild(cellMap[origIdx]);
  });
  dataCells.forEach(function (c) {
    if (!row.contains(c)) row.appendChild(c);
  });
  tailCells.forEach(function (c) {
    row.appendChild(c);
  });
}

// ── Column resize ───────────────────────────────────────────────────────────
function initColumnResize(table) {
  var ths = Array.from(table.querySelectorAll("thead th"));
  ths.forEach(function (th, i) {
    if (i === ths.length - 1) return;
    th.style.position = "relative";
    var handle = document.createElement("div");
    handle.style.cssText =
      "position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:10;";
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var startX = e.clientX,
        startW = th.offsetWidth;
      var line = document.createElement("div");
      line.style.cssText =
        "position:fixed;top:0;bottom:0;width:2px;background:oklch(0.585 0.233 277.117);opacity:0.5;pointer-events:none;z-index:9999;";
      line.style.left = e.clientX + "px";
      document.body.appendChild(line);
      function onMove(ev) {
        var newW = Math.max(40, startW + ev.clientX - startX);
        th.style.width = newW + "px";
        th.style.minWidth = newW + "px";
        line.style.left = ev.clientX + "px";
      }
      function onUp() {
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

// ── Column visibility (Columns dropdown with checkboxes) ────────────────────
function initColumnVisibility(table) {
  var dataThs = Array.from(table.querySelectorAll("thead th[data-orig-col]"));
  if (dataThs.length === 0) return;

  var wrap = table.closest("[data-frs-table-wrap]");
  var toolbar = wrap && wrap.previousElementSibling;
  if (!toolbar) return;

  var repo = table.getAttribute("data-frs-repo") || "default";
  var storageKey = "frs_cols_" + repo;
  var savedState = {};
  try {
    savedState = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch (_) {}

  function saveState(origIdx, visible) {
    savedState[origIdx] = visible;
    try {
      localStorage.setItem(storageKey, JSON.stringify(savedState));
    } catch (_) {}
  }

  function setColVisible(origIdx, visible) {
    var th = table.querySelector('thead th[data-orig-col="' + origIdx + '"]');
    if (th) th.style.display = visible ? "" : "none";
    table
      .querySelectorAll('tbody td[data-orig-col="' + origIdx + '"]')
      .forEach(function (td) {
        td.style.display = visible ? "" : "none";
      });
  }

  var cols = dataThs.map(function (th) {
    var origIdx = parseInt(th.getAttribute("data-orig-col"), 10);
    return {
      origIndex: origIdx,
      label: th.textContent.replace(/\s+/g, " ").trim(),
    };
  });

  // Build dropdown
  var dropdown = document.createElement("div");
  dropdown.className = "dropdown dropdown-end";

  var btn = document.createElement("button");
  btn.type = "button";
  btn.tabIndex = 0;
  btn.className = "btn btn-sm btn-outline gap-1";
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M9 4v16M15 4v16M4 9h16M4 15h16"/>' +
    "</svg> Columns";
  dropdown.appendChild(btn);

  var menu = document.createElement("ul");
  menu.tabIndex = 0;
  menu.className =
    "dropdown-content menu bg-base-100 rounded-box z-50 p-2 shadow-lg border border-base-300 w-56 max-h-80 overflow-y-auto flex-nowrap";

  cols.forEach(function (col) {
    var li = document.createElement("li");
    var label = document.createElement("label");
    label.className =
      "flex items-center gap-2 cursor-pointer px-2 py-1.5 rounded hover:bg-base-200";

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checkbox checkbox-xs checkbox-primary";
    var isVisible = savedState[col.origIndex] !== false;
    cb.checked = isVisible;

    var span = document.createElement("span");
    span.className = "text-sm select-none";
    span.textContent = col.label || "Column " + (col.origIndex + 1);

    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);

    if (!isVisible) setColVisible(col.origIndex, false);

    cb.addEventListener("change", function (e) {
      var visible = e.target.checked;
      setColVisible(col.origIndex, visible);
      saveState(col.origIndex, visible);
    });

    menu.appendChild(li);
  });

  dropdown.appendChild(menu);
  toolbar.appendChild(dropdown);
}

// ── Column reorder (drag grip handles on headers) ───────────────────────────
function initColumnReorder(table) {
  var repo = table.getAttribute("data-frs-repo") || "default";
  var orderKey = "frs_colorder_" + repo;
  var dragSrcTh = null;
  var allDataThs = Array.from(
    table.querySelectorAll("thead th[data-orig-col]"),
  );
  if (allDataThs.length < 2) return;

  allDataThs.forEach(function (th) {
    // Prepend a drag grip
    var grip = document.createElement("span");
    grip.draggable = true;
    grip.textContent = "\u2807";
    grip.style.cssText =
      "cursor:grab;opacity:0.18;margin-right:4px;font-size:14px;vertical-align:middle;user-select:none;display:inline-block;";
    grip.addEventListener("mouseenter", function () {
      grip.style.opacity = "0.5";
    });
    grip.addEventListener("mouseleave", function () {
      grip.style.opacity = "0.18";
    });
    th.insertBefore(grip, th.firstChild);

    // Drag starts from the grip only
    grip.addEventListener("dragstart", function (e) {
      dragSrcTh = th;
      th.style.opacity = "0.35";
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "col");
      try {
        e.dataTransfer.setDragImage(th, 20, 16);
      } catch (_) {}
    });

    grip.addEventListener("dragend", function () {
      if (dragSrcTh) dragSrcTh.style.opacity = "";
      dragSrcTh = null;
      allDataThs.forEach(function (t) {
        t.style.boxShadow = "";
      });
    });

    // Drop target is the full <th>
    th.addEventListener("dragover", function (e) {
      if (!dragSrcTh || dragSrcTh === th) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      allDataThs.forEach(function (t) {
        t.style.boxShadow = "";
      });
      var rect = th.getBoundingClientRect();
      var midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        th.style.boxShadow = "inset 3px 0 0 oklch(0.585 0.233 277.117)";
      } else {
        th.style.boxShadow = "inset -3px 0 0 oklch(0.585 0.233 277.117)";
      }
    });

    th.addEventListener("dragleave", function () {
      th.style.boxShadow = "";
    });

    th.addEventListener("drop", function (e) {
      e.preventDefault();
      if (!dragSrcTh || dragSrcTh === th) return;
      allDataThs.forEach(function (t) {
        t.style.boxShadow = "";
      });

      var headRow = th.parentNode;
      var rect = th.getBoundingClientRect();
      var midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        headRow.insertBefore(dragSrcTh, th);
      } else {
        headRow.insertBefore(dragSrcTh, th.nextElementSibling);
      }

      // Read new order from the reordered thead
      var newOrder = Array.from(
        table.querySelectorAll("thead th[data-orig-col]"),
      ).map(function (t) {
        return parseInt(t.getAttribute("data-orig-col"), 10);
      });

      // Apply the same order to all tbody rows
      table.querySelectorAll("tbody tr").forEach(function (row) {
        reorderRow(row, newOrder);
      });

      // Persist
      try {
        localStorage.setItem(orderKey, JSON.stringify(newOrder));
      } catch (_) {}
    });
  });
}
