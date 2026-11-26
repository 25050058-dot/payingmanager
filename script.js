import { FinanceStore } from "./finance-store.js";

const screens = document.querySelectorAll(".screen");
const navButtons = document.querySelectorAll(".nav-item");
const storageStatus = document.querySelector("#storage-status");
const historyList = document.querySelector("#history-list");
const fundList = document.querySelector("#fund-summary");
const currentPeriodIncomeInput = document.querySelector("#current-period-income");
const totalFundDisplay = document.querySelector("#total-fund-amount");
const walletBalanceDisplay = document.querySelector("#current-wallet-balance");
const categoryChoices = document.querySelector("#category-choices");
const transactionForm = document.querySelector("#transaction-form");
const transactionAmount = document.querySelector("#transaction-amount");
const transactionDate = document.querySelector("#transaction-date");
const transactionNote = document.querySelector("#transaction-note");
const feedback = document.querySelector("#transaction-feedback");
const financeStore = new FinanceStore();

const ICON_OPTIONS = ["🍲", "🏠", "🚲", "🧾", "💼", "🪙", "☕", "📚", "🎮", "🎁"];
const CHART_COLORS = ["#20d8d3", "#ecff76", "#706f75", "#ffbf69", "#ef7373", "#8d8e9b"];

const moneyFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function readLocalJson(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch (error) {
    console.error(`Không thể đọc dữ liệu cục bộ "${key}".`, error);
    return fallback;
  }
}

const legacyLocalState = readLocalJson("finance-ui-state", {}) || {};
const savedNotes = readLocalJson(
  "finance-ui-notes",
  Array.isArray(legacyLocalState.notes) ? legacyLocalState.notes : [],
);
const funds = [];
const transactions = [];
const archivedPeriods = [];
const notes = Array.isArray(savedNotes) ? savedNotes : [];

let openingBalance = 0;
let currentPeriodIncome = Math.max(
  0,
  Number(readLocalJson("finance-ui-income-draft", 0)) || 0,
);
let periodStartedAt = new Date().toISOString();
let totalFundAmount = 0;
let mode = "chi";
let selectedFundId;
let draftSequence = 0;
let historyFilter = "all";
let historySearch = "";
let chartMode = "chi";
let requestInProgress = false;
let storageReady = false;

currentPeriodIncomeInput.value = String(currentPeriodIncome);
transactionDate.value = new Date().toISOString().slice(0, 10);

function hasCategory(fund) {
  return !fund.isDraft && Boolean(fund.name.trim());
}

function setStorageStatus(message, state = "error") {
  storageStatus.textContent = message;
  storageStatus.dataset.state = state;
  storageStatus.hidden = !message;
}

function renderAll() {
  renderFundSummary();
  renderHistory();
  renderCategoryChoices();
  renderAllocationColumns();
  renderOverviewChart();
  renderQuickNotes();
  updateTotalFundDisplay();
}

function applyState(state) {
  if (
    !state ||
    !Array.isArray(state.funds) ||
    !Array.isArray(state.transactions) ||
    !Array.isArray(state.archivedPeriods)
  ) {
    throw new Error("Dữ liệu tài chính trên thiết bị không hợp lệ.");
  }

  funds.splice(0, funds.length, ...state.funds);
  transactions.splice(0, transactions.length, ...state.transactions);
  archivedPeriods.splice(0, archivedPeriods.length, ...state.archivedPeriods);
  openingBalance = Number(state.openingBalance) || 0;
  periodStartedAt = state.periodStartedAt || new Date().toISOString();
  totalFundAmount = Number(state.walletBalance);
  if (!Number.isFinite(totalFundAmount)) {
    throw new Error("Số dư ví trên thiết bị không hợp lệ.");
  }
  renderAll();
}

async function loadLocalState() {
  const state = await financeStore.initialize();
  applyState(state);
  storageReady = true;
  setStorageStatus(
    navigator.serviceWorker?.controller
      ? "Dữ liệu lưu riêng trên thiết bị này; ứng dụng sẵn sàng dùng ngoại tuyến."
      : "Dữ liệu tài chính được lưu riêng trên thiết bị này.",
    "success",
  );
}

function saveNotesLocally() {
  try {
    localStorage.setItem("finance-ui-notes", JSON.stringify(notes));
  } catch (error) {
    setStorageStatus(`Không thể lưu ghi chú trên thiết bị: ${error.message}`);
  }
}

function saveIncomeDraftLocally() {
  try {
    localStorage.setItem("finance-ui-income-draft", String(currentPeriodIncome));
  } catch (error) {
    setStorageStatus(`Không thể lưu thu nhập đang nhập trên thiết bị: ${error.message}`);
  }
}

async function runLocalAction(button, feedbackElement, action) {
  if (!storageReady) {
    feedbackElement.textContent = "Dữ liệu trên thiết bị chưa sẵn sàng. Vui lòng đợi.";
    return;
  }
  if (requestInProgress) {
    feedbackElement.textContent = "Đang xử lý một yêu cầu khác. Vui lòng đợi.";
    return;
  }
  requestInProgress = true;
  document.querySelector(".app-shell").setAttribute("aria-busy", "true");
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    feedbackElement.textContent = error.message;
    setStorageStatus(error.message);
  } finally {
    if (button) button.disabled = false;
    requestInProgress = false;
    document.querySelector(".app-shell").removeAttribute("aria-busy");
  }
}

function getProgress(fund) {
  const limit = Number(fund.limitAmount);
  const current = Number(fund.currentAmount);

  if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(current) || current < 0) {
    throw new Error(`Dữ liệu tiến độ của khoảng "${fund.name}" không hợp lệ.`);
  }

  if (limit === 0) {
    return {
      limit,
      current,
      remaining: 0,
      remainingPercent: 0,
      overLimit: current,
    };
  }

  const remaining = Math.max(0, limit - current);
  const remainingPercent = Math.max(0, Math.min(100, (remaining / limit) * 100));
  const overLimit = Math.max(0, current - limit);

  return { limit, current, remaining, remainingPercent, overLimit };
}

function createProgressTrack(fund, ariaLabel, value = getProgress(fund).remainingPercent) {
  const track = document.createElement("div");
  track.className = "progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", ariaLabel);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(Math.round(value)));
  track.setAttribute("aria-valuetext", `${Math.round(value)}%`);

  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${value}%`;

  const progress = getProgress(fund);
  if (fund.mode === "chi" && progress.limit > 0 && progress.overLimit > 0) {
    fill.classList.add("is-over-limit");
  } else if (
    fund.mode === "chi" &&
    progress.limit > 0 &&
    progress.remainingPercent <= fund.alertThresholdPercent
  ) {
    fill.classList.add("is-near-limit");
  }

  track.append(fill);
  return track;
}

function createProgressAmount(fund, progress) {
  if (fund.mode === "thu") {
    return `Tổng đã thu: ${moneyFormatter.format(progress.current)}`;
  }

  if (progress.limit === 0) {
    return `Chưa phân bổ: ${moneyFormatter.format(0)} / ${moneyFormatter.format(0)}`;
  }

  if (progress.overLimit > 0) {
    return `Đã vượt ${moneyFormatter.format(progress.overLimit)} / ${moneyFormatter.format(progress.limit)}`;
  }

  return `Còn có thể chi: ${moneyFormatter.format(progress.remaining)} / ${moneyFormatter.format(progress.limit)}`;
}

function getIncomePercentage(fund) {
  const totalIncome = funds
    .filter((item) => item.mode === "thu")
    .reduce((sum, item) => sum + item.currentAmount, 0);

  return totalIncome > 0 ? (fund.currentAmount / totalIncome) * 100 : 0;
}

function getRemainingAllocation(fund) {
  return fund.mode === "chi"
    ? Math.max(0, fund.limitAmount - fund.currentAmount)
    : 0;
}

function getAvailableAllocation(exceptFundId) {
  const reserved = funds
    .filter((fund) => fund.mode === "chi" && fund.id !== exceptFundId)
    .reduce((sum, fund) => sum + getRemainingAllocation(fund), 0);

  return totalFundAmount - reserved;
}

function renderAllocationCapacity() {
  const remaining = funds
    .filter((fund) => fund.mode === "chi")
    .reduce((sum, fund) => sum + getRemainingAllocation(fund), 0);
  const available = totalFundAmount - remaining;
  const display = document.querySelector("#allocation-capacity");

  display.classList.toggle("is-overallocated", available < 0);
  display.textContent =
    available < 0
      ? `Hạn mức còn lại vượt số dư ví ${moneyFormatter.format(Math.abs(available))}. Chưa thể cấp thêm.`
      : `Đã cấp còn lại: ${moneyFormatter.format(remaining)} · Chưa phân bổ: ${moneyFormatter.format(available)}`;
}

function renderFundSummary() {
  fundList.replaceChildren();

  const activeFunds = funds.filter(hasCategory);

  if (activeFunds.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "fund-summary-empty";
    emptyState.textContent = "Chưa có quỹ được phân bổ. Mở mục Quỹ để cài đặt.";
    fundList.append(emptyState);
    return;
  }

  activeFunds.forEach((fund) => {
    const progress = getProgress(fund);
    const progressPercent = fund.mode === "thu"
      ? getIncomePercentage(fund)
      : progress.remainingPercent;
    const card = document.createElement("article");
    card.className = "fund-row";

    const heading = document.createElement("div");
    heading.className = "fund-row-heading";

    const name = document.createElement("span");
    name.textContent = `${fund.icon}  ${fund.name}`;

    const percent = document.createElement("strong");
    percent.textContent =
      fund.mode === "thu"
        ? `${Math.round(getIncomePercentage(fund))}% tổng thu`
        : `${Math.round(progress.remainingPercent)}% còn lại`;

    const track = createProgressTrack(
      fund,
      fund.mode === "thu"
        ? `${fund.name}: ${Math.round(progressPercent)}% tổng thu`
        : `${fund.name}: ${Math.round(progress.remainingPercent)}% còn lại`,
      progressPercent,
    );
    const amount = document.createElement("p");
    amount.className = "progress-amount";
    amount.textContent = createProgressAmount(fund, progress);

    heading.append(name, percent);
    card.append(heading, track, amount);
    fundList.append(card);
  });
}

function renderOverviewChart() {
  const donut = document.querySelector("#overview-donut");
  const legend = document.querySelector("#overview-legend");
  const totalEl = document.querySelector("#donut-total");
  const captionEl = document.querySelector("#donut-caption");

  captionEl.textContent = chartMode === "chi" ? "Tổng chi" : "Tổng thu";
  legend.replaceChildren();

  const matchingFunds = funds.filter(
    (item) => hasCategory(item) && item.mode === chartMode && item.currentAmount > 0,
  );
  const total = matchingFunds.reduce((sum, item) => sum + item.currentAmount, 0);
  totalEl.textContent = moneyFormatter.format(total);

  if (total <= 0) {
    donut.style.background = "conic-gradient(#e6e7ec 0% 100%)";
    const empty = document.createElement("li");
    empty.textContent = "Chưa có số liệu";
    legend.append(empty);
    return;
  }

  let acc = 0;
  const stops = matchingFunds.map((item, idx) => {
    const pct = (item.currentAmount / total) * 100;
    const start = acc;
    acc += pct;
    const color = CHART_COLORS[idx % CHART_COLORS.length];
    return `${color} ${start.toFixed(1)}% ${acc.toFixed(1)}%`;
  });
  donut.style.background = `conic-gradient(${stops.join(", ")})`;

  matchingFunds.slice(0, 5).forEach((item, idx) => {
    const pct = ((item.currentAmount / total) * 100).toFixed(0);
    const color = CHART_COLORS[idx % CHART_COLORS.length];
    const li = document.createElement("li");
    li.innerHTML = `<span><i class="legend-swatch" style="background:${color}"></i>${item.name}</span><strong>${pct}%</strong>`;
    legend.append(li);
  });
}

function renderQuickNotes() {
  const listEl = document.querySelector("#quick-notes-list");
  const countEl = document.querySelector("#notes-count");
  if (!listEl || !countEl) return;

  listEl.replaceChildren();
  countEl.textContent = String(notes.length);

  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "notes-empty";
    empty.textContent = "Chưa có ghi chú nào.";
    listEl.append(empty);
    return;
  }

  notes.forEach((note) => {
    const item = document.createElement("div");
    item.className = `quick-note-item ${note.done ? "is-done" : ""}`;

    const label = document.createElement("label");
    label.className = "quick-note-check";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(note.done);
    checkbox.addEventListener("change", () => {
      note.done = checkbox.checked;
      saveNotesLocally();
      renderQuickNotes();
    });

    const text = document.createElement("span");
    text.className = "quick-note-text";
    text.textContent = note.text;

    label.append(checkbox, text);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "quick-note-del";
    delBtn.setAttribute("aria-label", "Xóa ghi chú");
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => {
      const idx = notes.findIndex((n) => n.id === note.id);
      if (idx !== -1) {
        notes.splice(idx, 1);
        saveNotesLocally();
        renderQuickNotes();
      }
    });

    item.append(label, delBtn);
    listEl.append(item);
  });
}

async function deleteTransaction(txId, button) {
  await runLocalAction(button, storageStatus, async () => {
    applyState(await financeStore.deleteTransaction(txId));
  });
}

function renderHistory() {
  historyList.replaceChildren();

  const q = historySearch.trim().toLowerCase();
  const matchesFilter = (tx) => {
    if (historyFilter !== "all" && tx.mode !== historyFilter) return false;
    if (!q) return true;
    const hay = `${tx.description || ""} ${tx.fundName || ""} ${tx.title || ""}`.toLowerCase();
    return hay.includes(q);
  };

  if (!transactions.length && !archivedPeriods.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "history-empty";
    emptyState.textContent = "Chưa có giao dịch trong kỳ này";
    historyList.append(emptyState);
    return;
  }

  const appendPeriod = (label, periodTransactions, allowDelete, closingBalance) => {
    const filtered = periodTransactions.filter(matchesFilter);
    if (!filtered.length && (q || historyFilter !== "all")) return;

    const section = document.createElement("section");
    section.className = "history-period";

    const heading = document.createElement("h2");
    heading.textContent = label;
    section.append(heading);

    if (filtered.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.className = "history-empty";
      emptyState.textContent = "Chưa có giao dịch";
      section.append(emptyState);
    }

    filtered.forEach((transaction) => {
      const item = document.createElement("div");
      item.className = "history-item";

      const main = document.createElement("div");
      main.className = "history-main";

      const description = document.createElement("span");
      description.textContent =
        transaction.description || transaction.fundName || transaction.title || "Giao dịch";

      const dateText = document.createElement("span");
      dateText.className = "history-date";
      const rawDate = transaction.txDate || transaction.occurredAt;
      const formattedDate = rawDate
        ? new Date(rawDate).toLocaleDateString("vi-VN")
        : "";
      dateText.textContent = [transaction.fundName, formattedDate].filter(Boolean).join(" · ");

      main.append(description, dateText);

      const actions = document.createElement("div");
      actions.className = "history-actions";

      const amount = document.createElement("strong");
      const sign = transaction.mode === "thu" ? "+" : "-";
      amount.textContent = `${sign}${moneyFormatter.format(Number(transaction.amount) || 0)}`;
      amount.classList.add(transaction.mode === "thu" ? "income-amount" : "expense-amount");
      actions.append(amount);

      if (allowDelete && transaction.id) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "history-delete";
        delBtn.textContent = "Xóa";
        delBtn.addEventListener("click", () => deleteTransaction(transaction.id, delBtn));
        actions.append(delBtn);
      }

      item.append(main, actions);
      section.append(item);
    });

    if (closingBalance !== undefined) {
      const closing = document.createElement("p");
      closing.className = "history-period-balance";
      closing.textContent = `Số dư khi chốt kỳ: ${moneyFormatter.format(closingBalance)}`;
      section.append(closing);
    }

    historyList.append(section);
  };

  appendPeriod("Kỳ hiện tại", transactions, true);
  [...archivedPeriods].reverse().forEach((period, index) => {
    const periodNumber = archivedPeriods.length - index;
    appendPeriod(
      `Kỳ ${periodNumber}`,
      Array.isArray(period.transactions) ? period.transactions : [],
      false,
      Number(period.closingBalance) || 0,
    );
  });

  if (!historyList.children.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "history-empty";
    emptyState.textContent = "Không có giao dịch khớp bộ lọc";
    historyList.append(emptyState);
  }
}

function renderEntryProgress() {
  const fund = funds.find((item) => item.id === selectedFundId);
  const name = document.querySelector("#entry-progress-name");
  const percent = document.querySelector("#entry-progress-percent");
  const track = document.querySelector("#entry-progress-bar");
  const fill = document.querySelector("#entry-progress-fill");
  const amount = document.querySelector("#entry-progress-amount");

  if (!fund) {
    name.textContent = "Chưa có khoảng phù hợp";
    percent.textContent = "--";
    track.setAttribute("aria-valuenow", "0");
    track.setAttribute("aria-valuetext", "Chưa có dữ liệu");
    fill.style.width = "0%";
    fill.className = "progress-fill";
    amount.textContent = "";
    return;
  }

  const progress = getProgress(fund);
  const isIncome = fund.mode === "thu";
  const pendingExpense = !isIncome ? evaluateAmountExpr(transactionAmount.value) : 0;
  const projectedCurrent = progress.current + pendingExpense;
  const projectedProgress = {
    ...progress,
    current: projectedCurrent,
    remaining: Math.max(0, progress.limit - projectedCurrent),
    remainingPercent:
      progress.limit > 0
        ? Math.max(0, Math.min(100, ((progress.limit - projectedCurrent) / progress.limit) * 100))
        : 0,
    overLimit: Math.max(0, projectedCurrent - progress.limit),
  };
  const progressPercent = isIncome ? getIncomePercentage(fund) : projectedProgress.remainingPercent;
  name.textContent = `${fund.icon} ${fund.name}`;
  percent.textContent = isIncome
    ? `${Math.round(progressPercent)}% tổng thu`
    : `${Math.round(progressPercent)}% còn lại`;
  track.setAttribute("aria-label", isIncome ? "Tỉ trọng khoản thu" : "Ngân sách còn lại");
  track.setAttribute("aria-valuenow", String(Math.round(progressPercent)));
  track.setAttribute(
    "aria-valuetext",
    isIncome
      ? `${Math.round(progressPercent)}% tổng thu`
      : `${Math.round(progressPercent)}% còn lại`,
  );
  fill.style.width = `${progressPercent}%`;
  fill.className = "progress-fill";

  if (!isIncome && progress.limit > 0 && projectedProgress.overLimit > 0) {
    fill.classList.add("is-over-limit");
  } else if (
    !isIncome &&
    progress.limit > 0 &&
    projectedProgress.remainingPercent <= fund.alertThresholdPercent
  ) {
    fill.classList.add("is-near-limit");
  }

  amount.textContent = createProgressAmount(
    fund,
    isIncome ? progress : projectedProgress,
  );
}

function renderCategoryChoices() {
  categoryChoices.replaceChildren();
  const availableFunds = funds.filter((fund) => hasCategory(fund) && fund.mode === mode);

  if (!availableFunds.some((fund) => fund.id === selectedFundId)) {
    selectedFundId = availableFunds[0]?.id;
  }

  if (availableFunds.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "category-empty";
    emptyState.textContent = "Chưa có khoảng nào cho chế độ này.";
    categoryChoices.append(emptyState);
  }

  availableFunds.forEach((fund) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "category-choice";
    choice.classList.toggle("selected", fund.id === selectedFundId);
    choice.setAttribute("aria-pressed", String(fund.id === selectedFundId));

    const icon = document.createElement("span");
    icon.className = "category-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = fund.icon;

    const label = document.createElement("span");
    label.textContent = fund.name;

    choice.append(icon, label);
    choice.addEventListener("click", () => {
      selectedFundId = fund.id;
      renderCategoryChoices();
      renderEntryProgress();
    });
    categoryChoices.append(choice);
  });

  renderEntryProgress();
}

function updateAllocationMeter(form, percent, amount) {
  const range = form.querySelector(".allocation-range");
  const share = form.querySelector(".allocation-share");
  const roundedPercent = Math.round(percent);

  range.setAttribute(
    "aria-valuetext",
    `${roundedPercent}% khi cấp, ${moneyFormatter.format(amount)}`,
  );
  share.textContent = `${roundedPercent}% khi cấp · ${moneyFormatter.format(amount)}`;
}

function updateAllocationFromAmount(form) {
  const amount = Math.max(0, Number(form.querySelector(".allocation-amount").value) || 0);
  const percent = totalFundAmount > 0 ? (amount / totalFundAmount) * 100 : 0;
  const range = form.querySelector(".allocation-range");

  range.value = String(Math.min(100, Math.max(0, percent)));
  updateAllocationMeter(form, percent, amount);
}

function updateAllocationFromPercent(form) {
  const percent = Number(form.querySelector(".allocation-range").value) || 0;
  const amount = Math.round((totalFundAmount * percent) / 100);

  form.querySelector(".allocation-amount").value = String(amount);
  updateAllocationMeter(form, percent, amount);
}

function updateTotalFundDisplay() {
  totalFundDisplay.textContent = moneyFormatter.format(totalFundAmount);
  walletBalanceDisplay.textContent = moneyFormatter.format(totalFundAmount);
  walletBalanceDisplay.classList.toggle("is-negative", totalFundAmount < 0);
  renderAllocationCapacity();
}

function savePendingIncome() {
  currentPeriodIncome = Math.max(0, Number(currentPeriodIncomeInput.value) || 0);
  saveIncomeDraftLocally();
}

async function transferIncomeToFund(button) {
  currentPeriodIncome = Math.max(0, Number(currentPeriodIncomeInput.value) || 0);

  if (currentPeriodIncome === 0) {
    document.querySelector("#allocation-feedback").textContent =
      "Nhập thu nhập kỳ này trước khi chuyển vào tổng quỹ.";
    return;
  }

  await runLocalAction(button, document.querySelector("#allocation-feedback"), async () => {
    const state = await financeStore.createTransaction({
      mode: "thu",
      amount: currentPeriodIncome,
      description: "Thu nhập chính kỳ này",
      source: "main-pool",
    });
    currentPeriodIncome = 0;
    currentPeriodIncomeInput.value = "0";
    saveIncomeDraftLocally();
    applyState(state);
    document.querySelector("#allocation-feedback").textContent =
      "Đã cộng thu nhập vào số dư ví. Hạn mức chi giữ nguyên.";
  });
}

async function startNewPeriod(button) {
  const confirmed = window.confirm(
    `Chốt kỳ và bắt đầu kỳ mới?\n\nSố dư hiện tại ${moneyFormatter.format(totalFundAmount)} sẽ được chuyển sang kỳ mới. Lịch sử kỳ cũ được lưu; các hạn mức chi giữ nguyên. Thu nhập chưa chuyển vào tổng quỹ sẽ không được cộng.`,
  );

  if (!confirmed) {
    return;
  }

  await runLocalAction(button, document.querySelector("#allocation-feedback"), async () => {
    const state = await financeStore.closePeriod();
    currentPeriodIncome = 0;
    currentPeriodIncomeInput.value = "0";
    saveIncomeDraftLocally();
    applyState(state);
    document.querySelector("#allocation-feedback").textContent =
      "Đã bắt đầu kỳ mới; số dư được chuyển tiếp và lịch sử kỳ cũ đã lưu.";
  });
}

function renderAllocationColumns() {
  [
    { mode: "chi", container: document.querySelector("#expense-allocations") },
    { mode: "thu", container: document.querySelector("#income-allocations") },
  ].forEach(({ mode: allocationMode, container }) => {
    container.replaceChildren();
    const categories = funds.filter((fund) => fund.mode === allocationMode);

    if (categories.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.className = "allocation-empty";
      emptyState.textContent = "Chưa có khoảng nào. Bấm + để thêm.";
      container.append(emptyState);
    }

    categories.forEach((fund) => {
      const form = document.createElement("form");
      form.className = "allocation-card";
      form.dataset.fundId = fund.id;

      let chosenIcon = fund.icon || (allocationMode === "thu" ? "💰" : "🧾");
      const iconBar = document.createElement("div");
      iconBar.className = "icon-picker-bar";
      ICON_OPTIONS.forEach((ic) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `icon-choice ${ic === chosenIcon ? "active" : ""}`;
        btn.textContent = ic;
        btn.addEventListener("click", () => {
          chosenIcon = ic;
          iconBar.querySelectorAll(".icon-choice").forEach((el) => el.classList.remove("active"));
          btn.classList.add("active");
        });
        iconBar.append(btn);
      });

      const nameLabel = document.createElement("label");
      nameLabel.className = "allocation-field-label";
      nameLabel.textContent = `Tên khoảng ${allocationMode}`;

      const nameInput = document.createElement("input");
      nameInput.className = "allocation-name";
      nameInput.type = "text";
      nameInput.name = "name";
      nameInput.placeholder = `Nhập tên khoảng ${allocationMode}`;
      nameInput.value = fund.name;
      nameInput.required = true;
      nameLabel.append(nameInput);

      const actions = document.createElement("div");
      actions.className = "allocation-actions";

      const saveButton = document.createElement("button");
      saveButton.className = "allocation-save";
      saveButton.type = "submit";
      saveButton.textContent = allocationMode === "chi" ? "Lưu hạn mức" : "Lưu khoảng thu";
      actions.append(saveButton);

      const deleteButton = document.createElement("button");
      deleteButton.className = "allocation-delete";
      deleteButton.type = "button";
      deleteButton.textContent = "Xóa";
      deleteButton.setAttribute("aria-label", `Xóa khoảng ${fund.name || allocationMode} này`);
      deleteButton.addEventListener("click", async () => {
        const fundName = fund.name || `khoảng ${allocationMode} mới`;
        const confirmed = window.confirm(
          `Xóa khoảng "${fundName}"? Lịch sử giao dịch cũ sẽ được giữ lại.`,
        );

        if (!confirmed) {
          return;
        }

        await runLocalAction(
          deleteButton,
          document.querySelector("#allocation-feedback"),
          async () => {
            if (fund.isDraft) {
              funds.splice(funds.indexOf(fund), 1);
              renderAll();
            } else {
              applyState(await financeStore.deleteFund(fund.id));
            }
            document.querySelector("#allocation-feedback").textContent =
              `Đã xóa khoảng ${fundName}. Lịch sử giao dịch cũ vẫn được giữ lại.`;
          },
        );
      });
      actions.append(deleteButton);

      form.append(iconBar, nameLabel);

      let amountInput;
      let percentInput;

      if (allocationMode === "chi") {
        const availableForFund = Math.max(0, getAvailableAllocation(fund.id));
        const maximumLimit = Math.max(
          fund.limitAmount,
          fund.currentAmount + availableForFund,
        );
        const maximumPercent =
          totalFundAmount > 0
            ? Math.min(100, (maximumLimit / totalFundAmount) * 100)
            : 0;

        const amountLabel = document.createElement("label");
        amountLabel.className = "allocation-field-label";
        amountLabel.textContent = "Hạn mức tiền được cấp";

        amountInput = document.createElement("input");
        amountInput.className = "allocation-amount";
        amountInput.type = "number";
        amountInput.name = "amount";
        amountInput.min = "0";
        amountInput.max = String(maximumLimit);
        amountInput.step = "1";
        amountInput.inputMode = "numeric";
        amountInput.placeholder = "Nhập số tiền";
        amountInput.value = String(fund.limitAmount);
        amountInput.required = true;
        amountLabel.append(amountInput);

        const percentLabel = document.createElement("label");
        percentLabel.className = "allocation-percent-label";
        percentLabel.textContent = "Tỉ lệ tại thời điểm cấp";

        percentInput = document.createElement("input");
        percentInput.className = "allocation-range";
        percentInput.type = "range";
        percentInput.name = "allocationPercent";
        percentInput.min = "0";
        percentInput.max = String(Math.max(fund.allocationPercent, maximumPercent));
        percentInput.step = "1";
        percentInput.value = String(fund.allocationPercent);
        percentInput.setAttribute(
          "aria-label",
          `Tỉ lệ cấp ban đầu cho khoảng ${fund.name || allocationMode}`,
        );
        percentLabel.append(percentInput);

        const share = document.createElement("output");
        share.className = "allocation-share";

        form.append(amountLabel, percentLabel, share);
        updateAllocationMeter(
          form,
          fund.allocationPercent,
          Number(amountInput.value) || 0,
        );

        amountInput.addEventListener("input", () => {
          updateAllocationFromAmount(form);
        });

        percentInput.addEventListener("input", () => {
          updateAllocationFromPercent(form);
        });
      } else {
        const explanation = document.createElement("p");
        explanation.className = "allocation-income-help";
        explanation.textContent =
          "Dùng để phân loại khoản thu khi nhập giao dịch; không đặt hạn mức hoặc tỉ lệ.";
        form.append(explanation);
      }

      form.append(actions);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        const requestBody = { name, icon: chosenIcon };
        if (allocationMode === "chi") {
          const nextLimit = Number(amountInput.value);
          const currentRemaining = getRemainingAllocation(fund);
          const nextRemaining = Math.max(0, nextLimit - fund.currentAmount);
          const availableForFund = getAvailableAllocation(fund.id);

          if (
            nextRemaining > currentRemaining &&
            nextRemaining > Math.max(0, availableForFund)
          ) {
            document.querySelector("#allocation-feedback").textContent =
              `Không thể cấp mức này: chỉ còn ${moneyFormatter.format(Math.max(0, availableForFund))} chưa phân bổ.`;
            return;
          }

          requestBody.limitAmount = nextLimit;
          requestBody.allocationPercent = Number(percentInput.value);
        }
        await runLocalAction(
          saveButton,
          document.querySelector("#allocation-feedback"),
          async () => {
            const state = fund.isDraft
              ? await financeStore.createFund({
                  ...requestBody,
                  mode: allocationMode,
                })
              : await financeStore.updateFund(fund.id, requestBody);
            applyState(state);
            document.querySelector("#allocation-feedback").textContent =
              `Đã lưu khoảng ${allocationMode}: ${name}.`;
          },
        );
      });

      container.append(form);
    });
  });

  renderAllocationCapacity();
}

function addAllocation(allocationMode) {
  const fund = {
    id: `${allocationMode}-draft-${Date.now()}-${++draftSequence}`,
    name: "",
    icon: allocationMode === "chi" ? "🧾" : "💰",
    mode: allocationMode,
    limitAmount: 0,
    currentAmount: 0,
    allocationPercent: 0,
    alertThresholdPercent: 20,
    isDraft: true,
  };

  funds.push(fund);
  renderAllocationColumns();
  document
    .querySelector(`[data-fund-id="${fund.id}"] .allocation-name`)
    .focus();
}

function evaluateAmountExpr(rawValue) {
  const cleaned = String(rawValue || "").replace(/[^0-9+\-]/g, "");
  if (!cleaned) return 0;
  const tokens = cleaned.match(/(\d+|[+\-])/g);
  if (!tokens) return 0;

  let total = 0;
  let sign = 1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "+") sign = 1;
    else if (token === "-") sign = -1;
    else total += sign * (Number(token) || 0);
  }
  return Math.max(0, Math.round(total));
}

function showScreen(name) {
  screens.forEach((screen) => screen.classList.remove("active"));
  document.querySelector(`#${name}-screen`).classList.add("active");

  if (name === "funds") {
    renderAllocationColumns();
  }
  if (name === "overview") {
    renderOverviewChart();
    renderQuickNotes();
  }

  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === name);
  });
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
});

document.querySelector("#history-search").addEventListener("input", (event) => {
  historySearch = event.target.value;
  renderHistory();
});

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    historyFilter = btn.dataset.filter;
    renderHistory();
  });
});

document.querySelectorAll(".chart-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    chartMode = btn.dataset.chartMode;
    renderOverviewChart();
  });
});

document.querySelector("#note-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#quick-note-input");
  const text = input.value.trim();
  if (!text) return;

  notes.unshift({
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    done: false,
  });
  input.value = "";
  saveNotesLocally();
  renderQuickNotes();
});

currentPeriodIncomeInput.addEventListener("input", savePendingIncome);
const transferIncomeButton = document.querySelector("#transfer-income");
transferIncomeButton.addEventListener("click", () => {
  transferIncomeToFund(transferIncomeButton);
});
const refreshPeriodButton = document.querySelector("#refresh-period");
refreshPeriodButton.addEventListener("click", () => {
  startNewPeriod(refreshPeriodButton);
});

document.querySelector("#add-expense-allocation").addEventListener("click", () => {
  addAllocation("chi");
});

document.querySelector("#add-income-allocation").addEventListener("click", () => {
  addAllocation("thu");
});

const exportButton = document.querySelector("#export-json");
exportButton.addEventListener("click", () => {
  runLocalAction(exportButton, storageStatus, async () => {
    const payload = await financeStore.getState();
    payload.notes = notes;
    payload.currentPeriodIncome = currentPeriodIncome;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `finance-state-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
});

document.querySelector("#import-json").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (
      !Array.isArray(imported.funds) ||
      !Array.isArray(imported.transactions) ||
      !Array.isArray(imported.archivedPeriods || [])
    ) {
      throw new Error("Invalid file");
    }
    if (!window.confirm(
      "Nhập file này sẽ thay thế toàn bộ quỹ, giao dịch và lịch sử trên thiết bị này. Tiếp tục?",
    )) {
      event.target.value = "";
      return;
    }
    await runLocalAction(
      event.target,
      document.querySelector("#allocation-feedback"),
      async () => {
        const importedState = await financeStore.replaceState(imported);
        notes.length = 0;
        if (Array.isArray(imported.notes)) {
          imported.notes.forEach((note) => notes.push(note));
        }
        saveNotesLocally();
        currentPeriodIncome = Math.max(0, Number(imported.currentPeriodIncome) || 0);
        currentPeriodIncomeInput.value = String(currentPeriodIncome);
        saveIncomeDraftLocally();
        applyState(importedState);
        document.querySelector("#allocation-feedback").textContent =
          "Đã nhập dữ liệu JSON thành công.";
      },
    );
  } catch (error) {
    document.querySelector("#allocation-feedback").textContent =
      `Không thể nhập dữ liệu: ${error.message}`;
    setStorageStatus(error.message);
  }
  event.target.value = "";
});

document.querySelectorAll(".calc-key").forEach((keyBtn) => {
  keyBtn.addEventListener("click", () => {
    const action = keyBtn.dataset.calc;
    const cur = transactionAmount.value.trim();

    if (action === "BACK") {
      transactionAmount.value = cur.slice(0, -1);
    } else if (action === "EVAL") {
      transactionAmount.value = String(evaluateAmountExpr(cur));
    } else if (action === "000") {
      if (cur) transactionAmount.value = `${cur}000`;
    } else if (action === "+" || action === "-") {
      if (!cur) transactionAmount.value = `0${action}`;
      else if (/[+\-]$/.test(cur)) transactionAmount.value = cur.slice(0, -1) + action;
      else transactionAmount.value = cur + action;
    } else {
      const addVal = Number(action) || 0;
      const base = evaluateAmountExpr(cur);
      transactionAmount.value = String(base + addVal);
    }

    renderEntryProgress();
  });
});

transactionAmount.addEventListener("input", renderEntryProgress);

const modeToggle = document.querySelector("#mode-toggle");
modeToggle.addEventListener("click", () => {
  mode = mode === "chi" ? "thu" : "chi";
  document.querySelector("#mode-label").textContent = mode;
  document.querySelector("#category-mode-label").textContent = mode;
  modeToggle.setAttribute("aria-pressed", String(mode === "thu"));
  modeToggle.classList.toggle("is-income", mode === "thu");
  renderCategoryChoices();
});

transactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const fund = funds.find((item) => item.id === selectedFundId);
  const amount = evaluateAmountExpr(transactionAmount.value);

  if (!fund || !Number.isFinite(amount) || amount <= 0) {
    feedback.textContent = "Hãy chọn khoảng và nhập số tiền lớn hơn 0.";
    return;
  }

  if (mode === "chi" && fund.limitAmount <= 0) {
    feedback.textContent = "Hãy phân bổ khoảng này trong mục Quỹ trước khi ghi giao dịch.";
    return;
  }

  const chosenDate = transactionDate.value || new Date().toISOString().slice(0, 10);
  const now = new Date();
  const [year, month, day] = chosenDate.split("-").map(Number);
  const occurredAt = new Date(
    year,
    month - 1,
    day,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ).toISOString();
  const submitButton = transactionForm.querySelector('button[type="submit"]');
  await runLocalAction(submitButton, feedback, async () => {
    const state = await financeStore.createTransaction({
      fundId: fund.id,
      mode,
      amount,
      description: transactionNote.value.trim(),
      occurredAt,
    });
    applyState(state);
    transactionForm.reset();
    transactionDate.value = new Date().toISOString().slice(0, 10);
    renderEntryProgress();
    feedback.textContent =
      mode === "thu"
        ? "Đã ghi khoản thu và cộng vào số dư ví."
        : "Đã ghi khoản chi và trừ khỏi số dư ví.";
    showScreen("overview");
  });
});

renderAll();
setStorageStatus("Đang mở dữ liệu trên thiết bị...", "loading");
loadLocalState().catch((error) => {
  setStorageStatus(`Không thể mở dữ liệu cục bộ: ${error.message}`);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./service-worker.js")
    .then((registration) => {
      const showOfflineReady = () => {
        if (!storageReady) return;
        setStorageStatus(
          "Dữ liệu lưu riêng trên thiết bị này; ứng dụng sẵn sàng dùng ngoại tuyến.",
          "success",
        );
      };
      if (registration.active || navigator.serviceWorker.controller) {
        showOfflineReady();
        return;
      }
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        showOfflineReady,
        { once: true },
      );
    })
    .catch((error) => {
      console.error("Không thể bật chế độ PWA ngoại tuyến.", error);
      setStorageStatus(
        `Dữ liệu vẫn lưu trên thiết bị, nhưng không thể bật bộ nhớ ngoại tuyến: ${error.message}`,
      );
    });
}