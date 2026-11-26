const DATABASE_NAME = "finance-manager-local";
const DATABASE_VERSION = 1;
const STORE_NAME = "appState";
const STATE_KEY = "current";

const DEFAULT_FUNDS = [
  ["food", "Ăn uống", "chi", "🍲"],
  ["housing", "Nhà cửa", "chi", "🏠"],
  ["transport", "Đi lại", "chi", "🚲"],
  ["other-expense", "Khác", "chi", "🧾"],
  ["salary", "Lương", "thu", "💼"],
  ["other-income", "Thu khác", "thu", "🪙"],
];

function createId(prefix) {
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireText(value, field, maximumLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} không được để trống.`);
  }
  const text = value.trim();
  if (text.length > maximumLength) {
    throw new Error(`${field} không được dài quá ${maximumLength} ký tự.`);
  }
  return text;
}

function requireAmount(value, field, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${field} phải là số nguyên ${allowZero ? "không âm" : "lớn hơn 0"}.`);
  }
  return value;
}

function requirePercent(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field} phải nằm trong khoảng 0–100.`);
  }
  return value;
}

function createInitialState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    periodId: createId("period"),
    periodStartedAt: now,
    openingBalance: 0,
    funds: DEFAULT_FUNDS.map(([id, name, mode, icon]) => ({
      id,
      name,
      mode,
      icon,
      limitAmount: 0,
      allocationPercent: 0,
      alertThresholdPercent: 20,
    })),
    transactions: [],
    archivedPeriods: [],
  };
}

function walletBalanceOf(state) {
  return state.transactions.reduce(
    (balance, transaction) =>
      balance + (transaction.mode === "thu" ? transaction.amount : -transaction.amount),
    state.openingBalance,
  );
}

function spentByFund(transactions) {
  const totals = new Map();
  transactions.forEach((transaction) => {
    if (!transaction.fundId) return;
    totals.set(
      transaction.fundId,
      (totals.get(transaction.fundId) || 0) + transaction.amount,
    );
  });
  return totals;
}

function deriveState(state) {
  const totals = spentByFund(state.transactions);
  const funds = state.funds.map((fund) => {
    const currentAmount = totals.get(fund.id) || 0;
    if (!Number.isSafeInteger(currentAmount)) {
      throw new Error("Tổng giao dịch của khoảng quỹ vượt giới hạn được hỗ trợ.");
    }
    const limitAmount = fund.mode === "chi" ? fund.limitAmount : 0;
    return {
      ...fund,
      limitAmount,
      currentAmount,
      remainingAllocation:
        fund.mode === "chi" ? Math.max(0, limitAmount - currentAmount) : 0,
      isDraft: false,
    };
  });
  const allocatedRemaining = funds
    .filter((fund) => fund.mode === "chi")
    .reduce((sum, fund) => sum + fund.remainingAllocation, 0);
  const walletBalance = walletBalanceOf(state);
  const unallocatedBalance = walletBalance - allocatedRemaining;
  if (
    !Number.isSafeInteger(walletBalance) ||
    !Number.isSafeInteger(allocatedRemaining) ||
    !Number.isSafeInteger(unallocatedBalance)
  ) {
    throw new Error("Tổng số dư hoặc hạn mức vượt giới hạn được hỗ trợ.");
  }

  return {
    ...clone(state),
    funds,
    walletBalance,
    totalFundAmount: walletBalance,
    allocatedRemaining,
    unallocatedBalance,
  };
}

function findFund(state, fundId) {
  const fund = state.funds.find((item) => item.id === fundId);
  if (!fund) throw new Error("Không tìm thấy khoảng quỹ này.");
  return fund;
}

function normalizeImportedState(payload) {
  if (
    !payload ||
    !Array.isArray(payload.funds) ||
    !Array.isArray(payload.transactions) ||
    !Array.isArray(payload.archivedPeriods || [])
  ) {
    throw new Error("Tệp sao lưu không có cấu trúc hợp lệ.");
  }

  const funds = [];
  const fundsById = new Map();
  payload.funds.forEach((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Dữ liệu khoảng quỹ không hợp lệ.");
    }
    const id = requireText(item.id, "Mã khoảng quỹ", 100);
    if (fundsById.has(id)) throw new Error("Mã khoảng quỹ bị trùng.");
    if (item.mode !== "chi" && item.mode !== "thu") {
      throw new Error("Loại khoảng quỹ không hợp lệ.");
    }
    if (item.icon !== undefined && typeof item.icon !== "string") {
      throw new Error("Biểu tượng khoảng quỹ không hợp lệ.");
    }
    const fund = {
      id,
      name: requireText(item.name, "Tên khoảng quỹ", 100),
      mode: item.mode,
      icon: typeof item.icon === "string" ? item.icon.slice(0, 16) : "",
      limitAmount:
        item.mode === "chi"
          ? requireAmount(item.limitAmount ?? 0, "Hạn mức", true)
          : 0,
      allocationPercent:
        item.mode === "chi"
          ? requirePercent(item.allocationPercent ?? 0, "Tỉ lệ phân bổ")
          : 0,
      alertThresholdPercent: requireAmount(
        item.alertThresholdPercent ?? 20,
        "Ngưỡng cảnh báo",
        true,
      ),
    };
    if (fund.alertThresholdPercent > 100) {
      throw new Error("Ngưỡng cảnh báo phải nằm trong khoảng 0–100.");
    }
    funds.push(fund);
    fundsById.set(id, fund);
  });

  const transactionIds = new Set();
  const readTransactions = (items, periodId, historical) => {
    if (!Array.isArray(items)) throw new Error("Danh sách giao dịch không hợp lệ.");
    return items.map((item) => {
      if (!item || typeof item !== "object" || !["chi", "thu"].includes(item.mode)) {
        throw new Error("Dữ liệu giao dịch không hợp lệ.");
      }
      const id = requireText(item.id || createId("transaction"), "Mã giao dịch", 100);
      if (transactionIds.has(id)) throw new Error("Mã giao dịch bị trùng.");
      transactionIds.add(id);
      if (
        item.fundId !== undefined &&
        item.fundId !== null &&
        typeof item.fundId !== "string"
      ) {
        throw new Error("Mã khoảng quỹ trong giao dịch không hợp lệ.");
      }
      const fundId = item.fundId || null;
      const fund = fundId ? fundsById.get(fundId) : null;
      if (fund && fund.mode !== item.mode) {
        throw new Error("Loại giao dịch không khớp với khoảng quỹ.");
      }
      if (!fundId && item.mode === "chi" && !historical) {
        throw new Error("Khoản chi phải thuộc về một khoảng chi.");
      }
      if (fundId && !fund && !item.fundName) {
        throw new Error("Giao dịch thiếu tên khoảng quỹ đã lưu.");
      }
      const occurredAt = item.occurredAt || item.txDate || new Date().toISOString();
      if (typeof occurredAt !== "string") {
        throw new Error("Ngày giao dịch không hợp lệ.");
      }
      return {
        id,
        periodId,
        fundId,
        fundName:
          (fund && fund.name) ||
          item.fundName ||
          (item.mode === "thu" && !fundId ? "Thu nhập chính" : ""),
        mode: item.mode,
        amount: requireAmount(item.amount, "Số tiền"),
        description: requireTextOptional(item.description ?? item.title, 500),
        occurredAt,
        source:
          item.source === undefined || item.source === null
            ? null
            : requireTextOptional(item.source, 100),
      };
    });
  };

  const currentPeriodId = requireText(
    payload.periodId || createId("period"),
    "Mã kỳ hiện tại",
    100,
  );
  const periodIds = new Set([currentPeriodId]);
  const archivedPeriods = (payload.archivedPeriods || []).map((period) => {
    if (!period || typeof period !== "object") {
      throw new Error("Dữ liệu kỳ đã lưu không hợp lệ.");
    }
    const periodId = requireText(
      period.periodId || createId("period"),
      "Mã kỳ đã lưu",
      100,
    );
    if (periodIds.has(periodId)) throw new Error("Mã kỳ ngân sách bị trùng.");
    periodIds.add(periodId);
    const openingBalance = period.openingBalance ?? 0;
    if (!Number.isSafeInteger(openingBalance)) {
      throw new Error("Số dư đầu kỳ đã lưu không hợp lệ.");
    }
    const transactions = readTransactions(
      period.transactions || [],
      periodId,
      true,
    );
    const computedBalance = transactions.reduce(
      (balance, item) => balance + (item.mode === "thu" ? item.amount : -item.amount),
      openingBalance,
    );
    const closingBalance =
      period.closingBalance === undefined || period.closingBalance === null
        ? computedBalance
        : period.closingBalance;
    if (!Number.isSafeInteger(closingBalance) || closingBalance !== computedBalance) {
      throw new Error("Số dư cuối kỳ không khớp với lịch sử giao dịch.");
    }
    if (period.allocations !== undefined && !Array.isArray(period.allocations)) {
      throw new Error("Danh sách hạn mức đã lưu không hợp lệ.");
    }
    const allocations = (period.allocations || []).map((allocation) => ({
      fundId: requireText(allocation.fundId, "Mã khoảng chi", 100),
      limitAmount: requireAmount(
        allocation.limitAmount ?? 0,
        "Hạn mức đã lưu",
        true,
      ),
      allocationPercent: requirePercent(
        allocation.allocationPercent ?? 0,
        "Tỉ lệ đã lưu",
      ),
    }));
    return {
      periodId,
      startedAt: String(period.startedAt || new Date().toISOString()),
      closedAt: String(period.closedAt || new Date().toISOString()),
      openingBalance,
      closingBalance,
      allocations,
      transactions,
    };
  });

  const openingBalance = payload.openingBalance ?? 0;
  if (!Number.isSafeInteger(openingBalance)) {
    throw new Error("Số dư đầu kỳ không hợp lệ.");
  }
  const transactions = readTransactions(
    payload.transactions,
    currentPeriodId,
    false,
  );
  const currentBalance = transactions.reduce(
    (balance, item) => balance + (item.mode === "thu" ? item.amount : -item.amount),
    openingBalance,
  );
  if (!Number.isSafeInteger(currentBalance)) {
    throw new Error("Số dư ví vượt quá giới hạn được hỗ trợ.");
  }

  return {
    schemaVersion: 1,
    periodId: currentPeriodId,
    periodStartedAt: String(payload.periodStartedAt || new Date().toISOString()),
    openingBalance,
    funds,
    transactions,
    archivedPeriods,
  };
}

export class FinanceStore {
  constructor() {
    this.databasePromise = null;
  }

  async initialize() {
    const database = await this.openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(STATE_KEY);
      request.onsuccess = () => {
        if (!request.result) store.put(createInitialState(), STATE_KEY);
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () =>
        reject(transaction.error || new Error("Không thể khởi tạo dữ liệu cục bộ."));
      transaction.onabort = () =>
        reject(transaction.error || new Error("Không thể khởi tạo dữ liệu cục bộ."));
    });
    return this.getState();
  }

  async getState() {
    const state = await this.readState();
    return deriveState(state);
  }

  async createFund(payload) {
    return this.updateState((state) => {
      const name = requireText(payload.name, "Tên khoảng quỹ", 100);
      if (!["chi", "thu"].includes(payload.mode)) {
        throw new Error("Loại khoảng quỹ không hợp lệ.");
      }
      const limitAmount =
        payload.mode === "chi"
          ? requireAmount(Number(payload.limitAmount ?? 0), "Hạn mức", true)
          : 0;
      const allocationPercent =
        payload.mode === "chi"
          ? requirePercent(Number(payload.allocationPercent ?? 0), "Tỉ lệ phân bổ")
          : 0;
      if (payload.mode === "chi") {
        const remaining = deriveState(state).allocatedRemaining;
        const unallocated = walletBalanceOf(state) - remaining;
        if (limitAmount > Math.max(0, unallocated)) {
          throw new Error("Hạn mức vượt quá số tiền chưa phân bổ trong ví.");
        }
      }
      state.funds.push({
        id: createId("fund"),
        name,
        mode: payload.mode,
        icon: typeof payload.icon === "string" ? payload.icon.slice(0, 16) : "",
        limitAmount,
        allocationPercent,
        alertThresholdPercent: 20,
      });
    });
  }

  async updateFund(fundId, payload) {
    return this.updateState((state) => {
      const fund = findFund(state, fundId);
      if ("name" in payload) fund.name = requireText(payload.name, "Tên khoảng quỹ", 100);
      if ("icon" in payload) {
        if (typeof payload.icon !== "string" || payload.icon.length > 16) {
          throw new Error("Biểu tượng không hợp lệ.");
        }
        fund.icon = payload.icon;
      }
      if ("alertThresholdPercent" in payload) {
        fund.alertThresholdPercent = requireAmount(
          Number(payload.alertThresholdPercent),
          "Ngưỡng cảnh báo",
          true,
        );
        if (fund.alertThresholdPercent > 100) {
          throw new Error("Ngưỡng cảnh báo phải nằm trong khoảng 0–100.");
        }
      }
      if ("limitAmount" in payload || "allocationPercent" in payload) {
        if (fund.mode !== "chi") {
          throw new Error("Khoản thu không có hạn mức chi.");
        }
        const nextLimit = "limitAmount" in payload
          ? requireAmount(Number(payload.limitAmount), "Hạn mức", true)
          : fund.limitAmount;
        const nextPercent = "allocationPercent" in payload
          ? requirePercent(Number(payload.allocationPercent), "Tỉ lệ phân bổ")
          : fund.allocationPercent;
        const spent = spentByFund(state.transactions).get(fund.id) || 0;
        const currentRemaining = Math.max(0, fund.limitAmount - spent);
        const nextRemaining = Math.max(0, nextLimit - spent);
        const otherRemaining = state.funds
          .filter((item) => item.mode === "chi" && item.id !== fund.id)
          .reduce((sum, item) => {
            const itemSpent = spentByFund(state.transactions).get(item.id) || 0;
            return sum + Math.max(0, item.limitAmount - itemSpent);
          }, 0);
        const availableForFund = walletBalanceOf(state) - otherRemaining;
        if (
          nextRemaining > currentRemaining &&
          nextRemaining > Math.max(0, availableForFund)
        ) {
          throw new Error("Hạn mức vượt quá số tiền chưa phân bổ trong ví.");
        }
        fund.limitAmount = nextLimit;
        fund.allocationPercent = nextPercent;
      }
    });
  }

  async deleteFund(fundId) {
    return this.updateState((state) => {
      const index = state.funds.findIndex((fund) => fund.id === fundId);
      if (index < 0) throw new Error("Không tìm thấy khoảng quỹ này.");
      state.funds.splice(index, 1);
    });
  }

  async createTransaction(payload) {
    return this.updateState((state) => {
      if (!["chi", "thu"].includes(payload.mode)) {
        throw new Error("Loại giao dịch không hợp lệ.");
      }
      const amount = requireAmount(Number(payload.amount), "Số tiền");
      const fundId = payload.fundId || null;
      let fundName = "Thu nhập chính";
      if (!fundId && payload.mode !== "thu") {
        throw new Error("Khoản chi phải thuộc về một khoảng chi.");
      }
      if (fundId) {
        const fund = findFund(state, fundId);
        if (fund.mode !== payload.mode) {
          throw new Error("Loại giao dịch không khớp với khoảng quỹ.");
        }
        if (payload.mode === "chi" && fund.limitAmount <= 0) {
          throw new Error("Hãy cấp hạn mức cho khoảng chi này trước.");
        }
        fundName = fund.name;
      }
      state.transactions.push({
        id: createId("transaction"),
        periodId: state.periodId,
        fundId,
        fundName,
        mode: payload.mode,
        amount,
        description: requireTextOptional(payload.description, 500),
        occurredAt:
          typeof payload.occurredAt === "string"
            ? payload.occurredAt
            : new Date().toISOString(),
        source: typeof payload.source === "string" ? payload.source : null,
      });
    });
  }

  async deleteTransaction(transactionId) {
    return this.updateState((state) => {
      const index = state.transactions.findIndex((item) => item.id === transactionId);
      if (index < 0) throw new Error("Không tìm thấy giao dịch trong kỳ hiện tại.");
      state.transactions.splice(index, 1);
    });
  }

  async closePeriod() {
    return this.updateState((state) => {
      const closingBalance = walletBalanceOf(state);
      const now = new Date().toISOString();
      state.archivedPeriods.push({
        periodId: state.periodId,
        startedAt: state.periodStartedAt,
        closedAt: now,
        openingBalance: state.openingBalance,
        closingBalance,
        allocations: state.funds
          .filter((fund) => fund.mode === "chi")
          .map((fund) => ({
            fundId: fund.id,
            limitAmount: fund.limitAmount,
            allocationPercent: fund.allocationPercent,
          })),
        transactions: state.transactions,
      });
      state.periodId = createId("period");
      state.periodStartedAt = now;
      state.openingBalance = closingBalance;
      state.transactions = [];
    });
  }

  async replaceState(payload) {
    const replacement = normalizeImportedState(payload);
    return this.updateState((state) => {
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, replacement);
    });
  }

  async updateState(update) {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(STATE_KEY);
      let nextState;
      let failure;

      request.onsuccess = () => {
        try {
          nextState = request.result || createInitialState();
          update(nextState);
          deriveState(nextState);
          store.put(nextState, STATE_KEY);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      request.onerror = () => {
        failure = request.error || new Error("Không thể đọc dữ liệu trên thiết bị.");
        transaction.abort();
      };
      transaction.oncomplete = () => resolve(deriveState(nextState));
      transaction.onerror = () =>
        reject(failure || transaction.error || new Error("Không thể lưu dữ liệu trên thiết bị."));
      transaction.onabort = () =>
        reject(failure || transaction.error || new Error("Không thể lưu dữ liệu trên thiết bị."));
    });
  }

  async readState() {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => {
        if (!request.result) {
          reject(new Error("Dữ liệu chưa được khởi tạo trên thiết bị."));
          return;
        }
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error || new Error("Không thể đọc dữ liệu trên thiết bị."));
    });
  }

  openDatabase() {
    if (!globalThis.indexedDB) {
      return Promise.reject(
        new Error("Trình duyệt này không hỗ trợ lưu dữ liệu cục bộ cần thiết."),
      );
    }
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            this.databasePromise = null;
          };
          resolve(database);
        };
        request.onerror = () =>
          reject(request.error || new Error("Không thể mở cơ sở dữ liệu cục bộ."));
        request.onblocked = () =>
          reject(new Error("Đang có tab khác chặn cập nhật cơ sở dữ liệu."));
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }
}

function requireTextOptional(value, maximumLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new Error("Mô tả giao dịch không hợp lệ.");
  }
  return value.trim();
}
