// ── Shared helpers ──────────────────────────────────────────────────────────
function frsGetBasePath() {
  var root = document.querySelector("[data-frs-panel-root]");
  var bp = root && root.getAttribute("data-frs-base-path");
  if (typeof bp === "string") return bp.replace(/\/$/, "");
  return window.location.pathname.replace(/\/[^/]*\/?$/, "");
}

// ── Right panel (relations preview) ─────────────────────────────────────────
(function () {
  function panelEls() {
    return {
      root: document.querySelector("[data-frs-panel-root]"),
      backdrop: document.querySelector("[data-frs-panel-backdrop]"),
      panel: document.querySelector("[data-frs-panel]"),
      title: document.querySelector("[data-frs-panel-title]"),
      body: document.querySelector("[data-frs-panel-body]"),
    };
  }
  function openPanel(label) {
    var els = panelEls();
    if (!els.root || !els.panel) return;
    els.root.classList.remove("hidden");
    els.root.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () {
      if (els.backdrop) els.backdrop.style.opacity = "1";
      if (els.panel) {
        els.panel.classList.remove("translate-x-full");
        els.panel.style.transform = "translateX(0)";
        els.panel.style.translate = "0 0";
      }
    });
    if (els.title) els.title.textContent = label || "Relation";
    if (els.body) {
      els.body.innerHTML =
        '<div class="flex items-center justify-center py-12 text-base-content/40"><span class="loading loading-spinner loading-md"></span></div>';
    }
  }
  function closePanel() {
    var els = panelEls();
    if (!els.root || !els.panel) return;
    if (els.backdrop) els.backdrop.style.opacity = "0";
    if (els.panel) {
      els.panel.style.transform = "translateX(100%)";
      els.panel.style.translate = "100% 0";
      els.panel.classList.add("translate-x-full");
    }
    setTimeout(function () {
      els.root.classList.add("hidden");
      els.root.setAttribute("aria-hidden", "true");
    }, 200);
  }
  function getBasePath() {
    return frsGetBasePath();
  }
  function fetchPanel(url, label) {
    openPanel(label);
    fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        return r.text();
      })
      .then(function (html) {
        var els = panelEls();
        if (els.body) els.body.innerHTML = html;
      })
      .catch(function (err) {
        var els = panelEls();
        if (els.body) {
          els.body.innerHTML =
            '<div class="p-6 text-error text-sm">Error: ' +
            (err && err.message ? err.message : String(err)) +
            "</div>";
        }
      });
  }
  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-frs-relation]");
    if (trigger) {
      e.preventDefault();
      var type = trigger.getAttribute("data-frs-rel-type");
      var repo = trigger.getAttribute("data-frs-rel-repo");
      var fk = trigger.getAttribute("data-frs-rel-fk");
      var val = trigger.getAttribute("data-frs-rel-val");
      var label = trigger.getAttribute("data-frs-rel-label") || "Relation";
      var bp = getBasePath();
      var url;
      if (type === "one") {
        url =
          bp +
          "/" +
          encodeURIComponent(repo) +
          "/_panel?type=one&id=" +
          encodeURIComponent(val);
      } else {
        url =
          bp +
          "/" +
          encodeURIComponent(repo) +
          "/_panel?type=many&fk=" +
          encodeURIComponent(fk) +
          "&fv=" +
          encodeURIComponent(val);
      }
      fetchPanel(url, repo + " · " + label);
      return;
    }
    if (e.target.closest("[data-frs-panel-close]")) {
      closePanel();
      return;
    }
    if (e.target.closest("[data-frs-panel-backdrop]")) {
      closePanel();
      return;
    }
    var pageBtn = e.target.closest("[data-frs-panel-page]");
    if (pageBtn) {
      // Recompute URL by inspecting the current open panel context — encoded in the body's first anchor "Full view →"
      // Simpler: rebuild via the previous URL stored in data-attr.
      var fullViewLink = document.querySelector(
        "[data-frs-panel-body] a.btn-outline[href]",
      );
      if (!fullViewLink) return;
      var dir = pageBtn.getAttribute("data-frs-panel-page");
      var cursor = pageBtn.getAttribute("data-cursor") || "";
      var fullViewUrl = new URL(fullViewLink.href, window.location.href);
      var repo = fullViewUrl.pathname.split("/").filter(Boolean).pop();
      var bp = fullViewUrl.pathname.replace(/\/[^/]+\/?$/, "");
      var fk = "";
      var fv = "";
      fullViewUrl.searchParams.forEach(function (v, k) {
        if (k.indexOf("fv_") === 0) {
          fk = k.slice(3);
          fv = v;
        }
      });
      var url =
        bp +
        "/" +
        encodeURIComponent(repo) +
        "/_panel?type=many&fk=" +
        encodeURIComponent(fk) +
        "&fv=" +
        encodeURIComponent(fv) +
        "&cursor=" +
        encodeURIComponent(cursor) +
        "&dir=" +
        encodeURIComponent(dir);
      fetchPanel(url, repo);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePanel();
  });
})();

// ── Bulk selection + actions ────────────────────────────────────────────────
(function () {
  var state = {
    selectAllAcrossQuery: false,
    // Keep a Set of selected ids on the current page (cleared on navigation).
    selected: new Set(),
  };

  function bar() {
    return document.querySelector("[data-frs-bulk-bar]");
  }
  function summarize() {
    var b = bar();
    if (!b) return;
    var total = parseInt(b.getAttribute("data-frs-total") || "0", 10);
    var summary = b.querySelector("[data-frs-bulk-summary]");
    var selectAllBtn = b.querySelector("[data-frs-bulk-select-all]");
    var allActive = b.querySelector("[data-frs-bulk-all-active]");
    var pageSize = parseInt(b.getAttribute("data-frs-page-size") || "0", 10);
    var n = state.selected.size;
    if (state.selectAllAcrossQuery) {
      if (allActive) allActive.classList.remove("hidden");
      if (selectAllBtn) selectAllBtn.classList.add("hidden");
      if (summary) summary.textContent = "";
      b.classList.remove("hidden");
      return;
    }
    if (n === 0) {
      b.classList.add("hidden");
      if (selectAllBtn) selectAllBtn.classList.add("hidden");
      if (allActive) allActive.classList.add("hidden");
      return;
    }
    b.classList.remove("hidden");
    if (allActive) allActive.classList.add("hidden");
    if (summary) {
      summary.textContent =
        n + " selected" + (pageSize ? " on this page" : "");
    }
    if (selectAllBtn && total > n) {
      selectAllBtn.classList.remove("hidden");
    } else if (selectAllBtn) {
      selectAllBtn.classList.add("hidden");
    }
  }
  function syncHeader() {
    var head = document.querySelector("[data-frs-select-page]");
    if (!head) return;
    var rows = document.querySelectorAll("[data-frs-select-row]");
    var checked = 0;
    rows.forEach(function (r) {
      if (r.checked) checked++;
    });
    head.indeterminate = checked > 0 && checked < rows.length;
    head.checked = rows.length > 0 && checked === rows.length;
  }
  document.addEventListener("change", function (e) {
    if (e.target.matches("[data-frs-select-row]")) {
      var id = e.target.value;
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      state.selectAllAcrossQuery = false;
      syncHeader();
      summarize();
    } else if (e.target.matches("[data-frs-select-page]")) {
      var rows = document.querySelectorAll("[data-frs-select-row]");
      rows.forEach(function (r) {
        r.checked = e.target.checked;
        if (e.target.checked) state.selected.add(r.value);
        else state.selected.delete(r.value);
      });
      state.selectAllAcrossQuery = false;
      summarize();
    }
  });
  document.addEventListener("click", function (e) {
    var sa = e.target.closest("[data-frs-bulk-select-all]");
    if (sa) {
      state.selectAllAcrossQuery = true;
      summarize();
      return;
    }
    var clear = e.target.closest("[data-frs-bulk-clear]");
    if (clear) {
      state.selectAllAcrossQuery = false;
      state.selected.clear();
      document
        .querySelectorAll("[data-frs-select-row]")
        .forEach(function (r) {
          r.checked = false;
        });
      syncHeader();
      summarize();
      return;
    }
    var actBtn = e.target.closest("[data-frs-bulk-action]");
    if (actBtn) {
      var action = actBtn.getAttribute("data-frs-bulk-action");
      if (action === "delete") doBulkDelete();
      else if (action === "update") openBulkUpdateModal();
    }
  });

  function buildPayload() {
    var b = bar();
    if (!b) return null;
    if (state.selectAllAcrossQuery) {
      var filters = [];
      try {
        filters = JSON.parse(b.getAttribute("data-frs-filters") || "[]");
      } catch (_) {}
      return { selectAll: true, filters: filters };
    }
    return { ids: Array.from(state.selected) };
  }

  function repoEndpoint(action) {
    var b = bar();
    if (!b) return null;
    var repo = b.getAttribute("data-frs-repo");
    var bp = frsGetBasePath();
    return bp + "/" + encodeURIComponent(repo) + "/_bulk/" + action;
  }

  function doBulkDelete() {
    var payload = buildPayload();
    if (!payload) return;
    var n = state.selectAllAcrossQuery
      ? "all matching"
      : payload.ids.length + "";
    if (!confirm("Delete " + n + " documents? This cannot be undone.")) return;
    var url = repoEndpoint("delete");
    if (!url) return;
    fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, body: j };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          alert("Bulk delete failed: " + (res.body && res.body.error));
          return;
        }
        window.location.reload();
      })
      .catch(function (err) {
        alert("Bulk delete failed: " + err.message);
      });
  }

  function openBulkUpdateModal() {
    var b = bar();
    var dialog = document.getElementById("frs-bulk-update-modal");
    if (!b || !dialog) return;
    var fields = [];
    try {
      fields = JSON.parse(b.getAttribute("data-frs-fields") || "[]");
    } catch (_) {}
    if (fields.length === 0) return;
    var summary = dialog.querySelector(
      "[data-frs-bulk-update-summary]",
    );
    if (summary) {
      summary.textContent = state.selectAllAcrossQuery
        ? "Update one field on all matching documents."
        : "Update one field on " +
          state.selected.size +
          " selected document" +
          (state.selected.size !== 1 ? "s" : "") +
          ".";
    }
    var select = dialog.querySelector("[data-frs-bulk-field-select]");
    var valueContainer = dialog.querySelector(
      "[data-frs-bulk-value-container]",
    );
    var renderValueInput = function () {
      if (!valueContainer || !select) return;
      var name = select.value;
      if (!name) {
        valueContainer.innerHTML = "";
        return;
      }
      var template = document.querySelector(
        '[data-frs-bulk-template-for="' + escapeAttr(name) + '"]',
      );
      if (template) {
        valueContainer.innerHTML = template.innerHTML;
      } else {
        valueContainer.innerHTML = "";
      }
    };
    if (select) {
      select.value = "";
      select.onchange = renderValueInput;
    }
    if (valueContainer) valueContainer.innerHTML = "";
    var form = dialog.querySelector("[data-frs-bulk-update-form]");
    if (form) {
      form.onsubmit = function (e) {
        e.preventDefault();
        if (!select || !select.value) return;

        // Run validation & array serialization
        if (!frsSerializeForm(form)) return;

        var payload = buildPayload();
        if (!payload) return;
        payload.field = select.value;

        // Gather all form inputs except the select box itself
        var formData = new FormData(form);
        var formPayload = {};
        formData.forEach(function (value, key) {
          if (key === "field") return;
          if (formPayload[key] !== undefined) {
            if (!Array.isArray(formPayload[key])) {
              formPayload[key] = [formPayload[key]];
            }
            formPayload[key].push(value);
          } else {
            formPayload[key] = value;
          }
        });

        // Also merge hidden inputs created by the array serializer
        form.querySelectorAll("input[type=hidden][name]").forEach(function (h) {
          if (h.name !== "field") {
            formPayload[h.name] = h.value;
          }
        });

        payload.formPayload = formPayload;
        var url = repoEndpoint("update");
        if (!url) return;
        fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, body: j };
            });
          })
          .then(function (res) {
            if (!res.ok) {
              alert("Bulk update failed: " + (res.body && res.body.error));
              return;
            }
            dialog.close();
            window.location.reload();
          })
          .catch(function (err) {
            alert("Bulk update failed: " + err.message);
          });
      };
    }
    var cancel = dialog.querySelector("[data-frs-bulk-update-cancel]");
    if (cancel)
      cancel.onclick = function () {
        dialog.close();
      };
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
          c
        ] || c
      );
    });
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
})();

// ── Theme switcher ──────────────────────────────────────────────────────────
(function () {
  function syncThemeUI() {
    var current =
      document.documentElement.getAttribute("data-theme") || "corporate";
    var label = document.querySelector("[data-frs-theme-current]");
    if (label) label.textContent = current;
    document.querySelectorAll("[data-frs-theme-check]").forEach(function (el) {
      el.classList.toggle(
        "hidden",
        el.getAttribute("data-frs-theme-check") !== current,
      );
    });
  }
  document.addEventListener("DOMContentLoaded", syncThemeUI);
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-frs-theme]");
    if (!btn) return;
    var theme = btn.getAttribute("data-frs-theme");
    if (!theme) return;
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("frs-admin-theme", theme);
    } catch (_) {}
    syncThemeUI();
    // Close the dropdown by blurring focus (DaisyUI dropdown closes on focusout)
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  });
})();

// ── Form validation + array serialization ───────────────────────────────────
function frsSerializeForm(form) {
  // 1. Validate JSON textareas
  var valid = true;
  form.querySelectorAll("textarea[data-json]").forEach(function (ta) {
    var v = ta.value.trim();
    if (!v) return;
    try {
      JSON.parse(v);
    } catch (err) {
      valid = false;
      alert('Invalid JSON in field "' + ta.name + '":\n' + err.message);
    }
  });
  if (!valid) return false;

  // 2. Serialize array fields into hidden inputs
  form.querySelectorAll("[data-frs-array]").forEach(function (fieldset) {
    var hidden = fieldset.querySelector("input[type=hidden][name]");
    if (!hidden || hidden.disabled) return;

    var type = fieldset.getAttribute("data-frs-array-type");
    var items = fieldset.querySelectorAll("[data-frs-array-item]");
    var arr = [];

    if (type === "object") {
      items.forEach(function (item) {
        var obj = {};
        item.querySelectorAll("[data-frs-key]").forEach(function (inp) {
          var key = inp.getAttribute("data-frs-key");
          if (inp.type === "checkbox") {
            obj[key] = inp.checked;
          } else if (inp.type === "number") {
            obj[key] = inp.value === "" ? null : Number(inp.value);
          } else if (inp.tagName === "TEXTAREA") {
            var v = inp.value.trim();
            if (v) {
              try {
                obj[key] = JSON.parse(v);
              } catch (_) {
                obj[key] = v;
              }
            } else {
              obj[key] = null;
            }
          } else {
            obj[key] = inp.value;
          }
        });
        arr.push(obj);
      });
    } else {
      items.forEach(function (item) {
        var inp = item.querySelector("[data-frs-val]");
        if (!inp) return;
        if (type === "checkbox") {
          arr.push(inp.checked);
        } else if (type === "number") {
          if (inp.value !== "") arr.push(Number(inp.value));
        } else {
          if (inp.value !== "") arr.push(inp.value);
        }
      });
    }

    hidden.value = JSON.stringify(arr);
  });
  
  return true;
}

document.addEventListener("submit", function (e) {
  var form = e.target;
  if (!form.hasAttribute("data-frs-form")) return;
  if (!frsSerializeForm(form)) {
    e.preventDefault();
  }
});

// ── Array add / remove buttons ──────────────────────────────────────────────
document.addEventListener("click", function (e) {
  // Add item
  var addBtn = e.target.closest("[data-frs-array-add]");
  if (addBtn) {
    var fieldset = addBtn.closest("[data-frs-array]");
    if (!fieldset) return;
    var tpl = fieldset.querySelector("template[data-frs-array-tpl]");
    var container = fieldset.querySelector("[data-frs-array-items]");
    if (!tpl || !container) return;
    var clone = tpl.content.cloneNode(true);
    container.appendChild(clone);
    var last = container.lastElementChild;
    if (last) {
      var firstInp = last.querySelector("input,select,textarea");
      if (firstInp) firstInp.focus();
    }
    return;
  }

  // Remove item
  var rmBtn = e.target.closest("[data-frs-array-rm]");
  if (rmBtn) {
    var item = rmBtn.closest("[data-frs-array-item]");
    if (item) item.remove();
  }
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
  // Skip the leading selection (checkbox) column — it must always stay
  // visible and is not user-toggleable.
  var startIdx = 0;
  while (
    startIdx < ths.length &&
    ths[startIdx].querySelector("[data-frs-select-page]")
  ) {
    startIdx++;
  }
  var dataCount = countDataColumns(table, ths);
  for (var i = 0; i < dataCount; i++) {
    var th = ths[startIdx + i];
    if (!th) break;
    th.setAttribute("data-orig-col", String(i));
  }
  table.querySelectorAll("tbody tr").forEach(function (row) {
    var tds = Array.from(row.querySelectorAll("td"));
    var rowStart = 0;
    while (
      rowStart < tds.length &&
      tds[rowStart].querySelector("[data-frs-select-row]")
    ) {
      rowStart++;
    }
    for (var j = 0; j < dataCount && rowStart + j < tds.length; j++) {
      tds[rowStart + j].setAttribute("data-orig-col", String(j));
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
  var toolbar =
    (wrap &&
      (wrap.parentElement
        ? wrap.parentElement.querySelector("[data-frs-toolbar]")
        : null)) ||
    (wrap && wrap.previousElementSibling);
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
