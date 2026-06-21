/**
 * Our Home — Financial Portal · Cloudflare Worker (single-file deploy)
 * Serves the UI on "/" and exposes a JSON API on "/api/*"
 * Gated by Cloudflare Access (email + 2FA).
 *
 * Bindings required:
 *   env.DB  -> D1 database (your Cloudflare D1 binding)
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

async function periodId(env, year, month) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO periods (year, month) VALUES (?, ?)"
  ).bind(year, month).run();
  const row = await env.DB.prepare(
    "SELECT id FROM periods WHERE year = ? AND month = ?"
  ).bind(year, month).first();
  return row?.id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // ---------- Serve the UI ----------
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
        },
      });
    }

    if (pathname === "/api/health") return json({ ok: true, ts: Date.now() });

    // ---------- whoami (returns the Cloudflare Access user) ----------
    if (pathname === "/api/whoami" && method === "GET") {
      const email =
        request.headers.get("Cf-Access-Authenticated-User-Email") ||
        request.headers.get("cf-access-authenticated-user-email") ||
        null;
      return json({ email, ts: Date.now() });
    }

    try {
      // ---------- BOOTSTRAP ----------
      if (pathname === "/api/bootstrap" && method === "GET") {
        const [cats, items, contribs, periods] = await Promise.all([
          env.DB.prepare("SELECT * FROM categories WHERE active = 1 ORDER BY sort_order").all(),
          env.DB.prepare("SELECT * FROM line_items WHERE active = 1 ORDER BY category_id, sort_order, name").all(),
          env.DB.prepare("SELECT * FROM contributors ORDER BY sort_order, id").all(),
          env.DB.prepare("SELECT * FROM periods ORDER BY year, month").all(),
        ]);
        return json({
          categories: cats.results,
          line_items: items.results,
          contributors: contribs.results,
          periods: periods.results,
        });
      }

      // ---------- SUMMARY (dashboard) ----------
      if (pathname === "/api/summary" && method === "GET") {
        const year = Number(url.searchParams.get("year"));
        if (!year) return bad("year required");

        // Monthly expense from expense_entries
        const monthly = await env.DB.prepare(
          "SELECT month, total_income, total_expense, net FROM v_monthly_summary WHERE year = ? ORDER BY month"
        ).bind(year).all();

        // Installment burden per month (universal rule, applies to any month):
        //   Contributes monthly_payment IF
        //     (a) the month is in tenure window, AND
        //     (b) status != 'paid' OR paid_at_month >= this month
        const insts = await env.DB.prepare(
          "SELECT monthly_payment, start_year, start_month, num_months, status, paid_at_year, paid_at_month FROM installments"
        ).all();

        const burdenByMonth = {};
        for (const i of insts.results) {
          const sy = Number(i.start_year), sm = Number(i.start_month);
          const startIdx = sy * 12 + (sm - 1);
          const endIdx   = startIdx + Number(i.num_months); // exclusive
          const paidIdx = (i.status === 'paid' && i.paid_at_year && i.paid_at_month)
            ? Number(i.paid_at_year) * 12 + (Number(i.paid_at_month) - 1)
            : null;
          for (let m = 1; m <= 12; m++) {
            const idx = year * 12 + (m - 1);
            if (idx < startIdx || idx >= endIdx) continue;       // outside tenure
            if (paidIdx !== null && idx > paidIdx) continue;      // past paid_at → skip
            burdenByMonth[m] = (burdenByMonth[m] || 0) + Number(i.monthly_payment);
          }
        }
        // Add burden into total_expense and net for each month row
        const monthlyAdj = monthly.results.map(r => {
          const burden = burdenByMonth[r.month] || 0;
          return {
            ...r,
            total_expense: (r.total_expense || 0) + burden,
            net: (r.total_income || 0) - ((r.total_expense || 0) + burden)
          };
        });

        // Category breakdown from expense_entries (unchanged)
        const byCat = await env.DB.prepare(`SELECT c.name AS category, c.icon, SUM(ee.amount) AS total
          FROM expense_entries ee
          JOIN periods p     ON p.id = ee.period_id
          JOIN line_items li ON li.id = ee.line_item_id
          JOIN categories c  ON c.id = li.category_id
          WHERE p.year = ?
          GROUP BY c.id ORDER BY total DESC`).bind(year).all();

        // Add an "Installments" pseudo-category aggregating the year's total installment burden
        const yearBurden = Object.values(burdenByMonth).reduce((s, v) => s + v, 0);
        let byCategory = byCat.results || [];
        if (yearBurden > 0) {
          byCategory = [...byCategory, { category: 'Installments', icon: 'CreditCard', total: yearBurden }];
          byCategory.sort((a, b) => (b.total || 0) - (a.total || 0));
        }

        return json({ monthly: monthlyAdj, byCategory });
      }

      // ---------- DASHBOARD: aggregated data for all dashboard charts ----------
      if (pathname === "/api/dashboard" && method === "GET") {
        const year = Number(url.searchParams.get("year"));
        if (!year) return bad("year required");
        const now = new Date();
        const nowIdx = now.getFullYear() * 12 + now.getMonth();

        // ----- Helper: compute burden per (year, month) using universal rule -----
        const installments = (await env.DB.prepare(
          "SELECT monthly_payment, start_year, start_month, num_months, status, paid_at_year, paid_at_month, name FROM installments"
        ).all()).results;

        const burdenFor = (y, m) => {
          const idx = y * 12 + (m - 1);
          let sum = 0;
          for (const i of installments) {
            const startIdx = Number(i.start_year) * 12 + (Number(i.start_month) - 1);
            const endIdx   = startIdx + Number(i.num_months);
            if (idx < startIdx || idx >= endIdx) continue;
            if (i.status === 'paid' && i.paid_at_year && i.paid_at_month) {
              const paidIdx = Number(i.paid_at_year) * 12 + (Number(i.paid_at_month) - 1);
              if (idx > paidIdx) continue;
            }
            sum += Number(i.monthly_payment);
          }
          return sum;
        };

        // ----- 1. Monthly summary for requested year (with hasData flag for Fix Cliff #1) -----
        const monthly = (await env.DB.prepare(
          "SELECT month, total_income, total_expense, net FROM v_monthly_summary WHERE year = ? ORDER BY month"
        ).bind(year).all()).results;

        // Build full 12-month array with hasData flags
        const byMonth = {};
        for (const r of monthly) byMonth[r.month] = r;
        const monthlyAdj = [];
        for (let m = 1; m <= 12; m++) {
          const r = byMonth[m];
          const income = r ? Number(r.total_income || 0) : 0;
          const entryExp = r ? Number(r.total_expense || 0) : 0;
          const burden = burdenFor(year, m);
          const hasIncome = income > 0;
          const hasExpense = entryExp > 0 || burden > 0;
          monthlyAdj.push({
            month: m,
            total_income: hasIncome ? income : null,
            total_expense: hasExpense ? entryExp + burden : null,
            net: hasIncome && hasExpense ? income - entryExp - burden : null,
            burden,
            has_data: hasIncome || hasExpense
          });
        }

        // ----- 2. Multi-year savings rate (for chart #3) -----
        // For each year that has any data, compute monthly savings rate
        const allYears = (await env.DB.prepare(
          "SELECT DISTINCT year FROM periods ORDER BY year"
        ).all()).results.map(r => Number(r.year));

        const savingsRate = {}; // { 2024: [{m:1, rate:35.2}, ...], ... }
        for (const y of allYears) {
          const rows = (await env.DB.prepare(
            "SELECT month, total_income, total_expense FROM v_monthly_summary WHERE year = ? ORDER BY month"
          ).bind(y).all()).results;
          const map = {};
          for (const r of rows) map[r.month] = r;
          savingsRate[y] = [];
          for (let m = 1; m <= 12; m++) {
            const r = map[m];
            const income = r ? Number(r.total_income || 0) : 0;
            const expense = (r ? Number(r.total_expense || 0) : 0) + burdenFor(y, m);
            const hasData = income > 0 && expense > 0;
            savingsRate[y].push({
              month: m,
              rate: hasData ? ((income - expense) / income) * 100 : null
            });
          }
        }

        // ----- 3. Category breakdown current year (for existing Spend by Category chart) -----
        // Only household items contribute to the main chart; personal items are aggregated separately.
        const byCat = (await env.DB.prepare(`SELECT c.name AS category, c.icon, SUM(ee.amount) AS total
          FROM expense_entries ee
          JOIN periods p     ON p.id = ee.period_id
          JOIN line_items li ON li.id = ee.line_item_id
          JOIN categories c  ON c.id = li.category_id
          WHERE p.year = ? AND li.is_personal = 0
          GROUP BY c.id ORDER BY total DESC`).bind(year).all()).results;

        const yearBurden = monthlyAdj.reduce((s, r) => s + (r.burden || 0), 0);
        let byCategory = byCat || [];
        if (yearBurden > 0) {
          byCategory = [...byCategory, { category: 'Installments', icon: 'CreditCard', total: yearBurden }];
          byCategory.sort((a, b) => (b.total || 0) - (a.total || 0));
        }

        // ----- 3b. Personal deductions per contributor (current year, household-separated) -----
        const personalRows = (await env.DB.prepare(`
          SELECT c.id AS contributor_id, c.name AS contributor_name,
                 cat.name AS category, COALESCE(SUM(ee.amount), 0) AS total
          FROM contributors c
          JOIN line_items li ON li.assigned_contributor_id = c.id AND li.is_personal = 1
          JOIN expense_entries ee ON ee.line_item_id = li.id
          JOIN periods p ON p.id = ee.period_id
          JOIN categories cat ON cat.id = li.category_id
          WHERE p.year = ?
          GROUP BY c.id, cat.id
          ORDER BY c.sort_order, total DESC`).bind(year).all()).results;

        // Aggregate per contributor (totals + breakdown)
        const personalByPerson = {};
        for (const r of personalRows) {
          if (!personalByPerson[r.contributor_id]) {
            personalByPerson[r.contributor_id] = { name: r.contributor_name, total: 0, byCategory: [] };
          }
          personalByPerson[r.contributor_id].total += Number(r.total || 0);
          if (r.category) {
            personalByPerson[r.contributor_id].byCategory.push({ category: r.category, total: Number(r.total || 0) });
          }
        }

        // ----- 4. YoY category change (for chart #6) — apples-to-apples comparison -----
        // Determine last month with data in current year. If full year, compare full vs full.
        // If partial (e.g., only Jan-May), compare same months in both years.
        let yoyByCategory = [];
        let yoyPeriodLabel = "Full Year";
        const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        if (allYears.includes(year - 1)) {
          // Find last month with data in current year
          let lastMonthWithData = 0;
          for (let m = 1; m <= 12; m++) {
            if (monthlyAdj[m - 1].has_data) lastMonthWithData = m;
          }
          // If no data at all, skip YoY
          if (lastMonthWithData > 0) {
            const isPartial = lastMonthWithData < 12;
            yoyPeriodLabel = isPartial
              ? `Jan-${MONTH_NAMES[lastMonthWithData - 1]} only`
              : "Full Year";

            // Bound both queries to the same months (1..lastMonthWithData)
            // Only household items are compared (personal items show separately).
            const prevByCat = (await env.DB.prepare(`SELECT c.name AS category, SUM(ee.amount) AS total
              FROM expense_entries ee
              JOIN periods p ON p.id = ee.period_id
              JOIN line_items li ON li.id = ee.line_item_id
              JOIN categories c ON c.id = li.category_id
              WHERE p.year = ? AND p.month <= ? AND li.is_personal = 0
              GROUP BY c.id`).bind(year - 1, lastMonthWithData).all()).results;

            const currByCat = (await env.DB.prepare(`SELECT c.name AS category, SUM(ee.amount) AS total
              FROM expense_entries ee
              JOIN periods p ON p.id = ee.period_id
              JOIN line_items li ON li.id = ee.line_item_id
              JOIN categories c ON c.id = li.category_id
              WHERE p.year = ? AND p.month <= ? AND li.is_personal = 0
              GROUP BY c.id`).bind(year, lastMonthWithData).all()).results;

            // Burdens limited to same month range
            let prevBurden = 0;
            for (let m = 1; m <= lastMonthWithData; m++) prevBurden += burdenFor(year - 1, m);
            let currBurden = 0;
            for (let m = 1; m <= lastMonthWithData; m++) currBurden += burdenFor(year, m);

            const prevMap = {};
            for (const r of prevByCat) prevMap[r.category] = Number(r.total);
            if (prevBurden > 0) prevMap['Installments'] = prevBurden;

            const currMap = {};
            for (const r of currByCat) currMap[r.category] = Number(r.total);
            if (currBurden > 0) currMap['Installments'] = currBurden;

            const allCats = new Set([...Object.keys(prevMap), ...Object.keys(currMap)]);
            for (const cat of allCats) {
              const prev = prevMap[cat] || 0;
              const curr = currMap[cat] || 0;
              if (prev === 0 && curr === 0) continue;
              const change = prev === 0 ? 100 : ((curr - prev) / prev) * 100;
              yoyByCategory.push({ category: cat, prev, curr, change });
            }
            yoyByCategory.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
          }
        }

        // ----- 5. Burden evolution for next ~36 months (for chart #7) -----
        const burdenEvolution = [];
        const startYr = year;
        const startMo = 1;
        for (let i = 0; i < 36; i++) {
          const y = startYr + Math.floor((startMo - 1 + i) / 12);
          const m = ((startMo - 1 + i) % 12) + 1;
          burdenEvolution.push({
            year: y, month: m,
            label: `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m-1]} '${String(y).slice(2)}`,
            burden: burdenFor(y, m)
          });
        }

        // ----- 6. INSIGHTS for cards (#2) -----
        // (a) Avg monthly surplus across months with data this year
        const surplusMonths = monthlyAdj.filter(r => r.net !== null);
        const avgSurplus = surplusMonths.length
          ? surplusMonths.reduce((s, r) => s + r.net, 0) / surplusMonths.length
          : 0;

        // (b) Biggest YoY jump (already in yoyByCategory[0] sorted by abs change)
        const biggestJump = yoyByCategory.length ? yoyByCategory.filter(c => c.change > 0)[0] : null;

        // (c) Installments cleared count + total
        const totalIns = installments.length;
        const clearedIns = installments.filter(i => i.status === 'paid').length;
        const clearedThisYr = installments.filter(i =>
          i.status === 'paid' && Number(i.paid_at_year) === year
        );

        // (d) Next tenure ending — find earliest ending active item
        const activeInsts = installments.filter(i => i.status === 'active' || i.status === 'overdue');
        let nextEnding = null;
        let nextEndIdx = Infinity;
        for (const i of activeInsts) {
          const endIdx = Number(i.start_year) * 12 + (Number(i.start_month) - 1) + Number(i.num_months) - 1;
          if (endIdx > nowIdx && endIdx < nextEndIdx) {
            nextEndIdx = endIdx;
            nextEnding = {
              name: i.name,
              months_left: endIdx - nowIdx,
              monthly_payment: Number(i.monthly_payment)
            };
          }
        }

        return json({
          year,
          allYears,
          monthly: monthlyAdj,
          savingsRate,
          byCategory,
          personalByPerson,
          yoyByCategory,
          yoyPeriodLabel,
          burdenEvolution,
          insights: {
            avgSurplus,
            biggestJump,
            installmentsCleared: { cleared: clearedIns, total: totalIns, thisYear: clearedThisYr.length },
            nextEnding
          }
        });
      }

      // ---------- EXPENSE ENTRIES for a month ----------
      if (pathname === "/api/entries" && method === "GET") {
        const year = Number(url.searchParams.get("year"));
        const month = Number(url.searchParams.get("month"));
        if (!year || !month) return bad("year & month required");
        const rows = await env.DB.prepare(`SELECT li.id AS line_item_id, li.name, li.note, c.name AS category,
                 COALESCE(ee.amount, 0) AS amount
          FROM line_items li
          JOIN categories c ON c.id = li.category_id
          LEFT JOIN periods p ON p.year = ? AND p.month = ?
          LEFT JOIN expense_entries ee ON ee.line_item_id = li.id AND ee.period_id = p.id
          WHERE li.active = 1
          ORDER BY c.sort_order, li.sort_order, li.name`).bind(year, month).all();
        return json({ entries: rows.results });
      }

      // ---------- INCOME for a month ----------
      if (pathname === "/api/income" && method === "GET") {
        const year = Number(url.searchParams.get("year"));
        const month = Number(url.searchParams.get("month"));
        if (!year || !month) return bad("year & month required");
        const ymKey = year * 100 + month;
        const rows = await env.DB.prepare(`
          SELECT c.id AS contributor_id, c.name, c.default_share,
                 COALESCE(ie.salary, 0) AS salary,
                 (SELECT sh.share FROM share_history sh
                    WHERE sh.contributor_id = c.id
                      AND (sh.effective_year * 100 + sh.effective_month) <= ?
                    ORDER BY sh.effective_year DESC, sh.effective_month DESC
                    LIMIT 1) AS active_share
          FROM contributors c
          LEFT JOIN periods p ON p.year = ? AND p.month = ?
          LEFT JOIN income_entries ie ON ie.contributor_id = c.id AND ie.period_id = p.id
          ORDER BY c.sort_order, c.id`).bind(ymKey, year, month).all();

        // Household expense (split by share) — only items where is_personal = 0
        const hh = await env.DB.prepare(`
          SELECT COALESCE(SUM(ee.amount), 0) AS total
          FROM expense_entries ee
          JOIN periods p ON p.id = ee.period_id
          JOIN line_items li ON li.id = ee.line_item_id
          WHERE p.year = ? AND p.month = ? AND li.is_personal = 0`).bind(year, month).first();

        // Personal expense by contributor — sum of items assigned to each person
        const perPerson = await env.DB.prepare(`
          SELECT li.assigned_contributor_id AS contributor_id,
                 COALESCE(SUM(ee.amount), 0) AS total
          FROM expense_entries ee
          JOIN periods p ON p.id = ee.period_id
          JOIN line_items li ON li.id = ee.line_item_id
          WHERE p.year = ? AND p.month = ? AND li.is_personal = 1
            AND li.assigned_contributor_id IS NOT NULL
          GROUP BY li.assigned_contributor_id`).bind(year, month).all();

        const personalByContributor = {};
        for (const r of perPerson.results || []) personalByContributor[r.contributor_id] = Number(r.total);

        // Installment burden for THIS specific (year, month).
        //
        // Universal rule (applies to any month — past, current, or future):
        //   An installment contributes monthly_payment IF
        //     (a) the month is in its tenure window, AND
        //     (b) EITHER status != 'paid',
        //         OR (paid_at_year, paid_at_month) >= (this month)
        //              i.e. the month is on or before when it was paid off.
        const monthIdx = year * 12 + (month - 1);
        const insts = await env.DB.prepare(
          `SELECT COALESCE(SUM(monthly_payment), 0) AS burden
           FROM installments
           WHERE (start_year * 12 + (start_month - 1)) <= ?
             AND (start_year * 12 + (start_month - 1) + num_months) > ?
             AND (
               status != 'paid'
               OR paid_at_year IS NULL
               OR (paid_at_year * 12 + (paid_at_month - 1)) >= ?
             )`
        ).bind(monthIdx, monthIdx, monthIdx).first();

        return json({
          income: rows.results.map(r => ({
            contributor_id: r.contributor_id, name: r.name,
            share: r.active_share != null ? r.active_share : r.default_share,
            salary: r.salary
          })),
          monthly_expense: (hh.total || 0) + (insts.burden || 0),
          personal_by_contributor: personalByContributor,
          installment_burden: insts.burden || 0
        });
      }

      // ---------- UPSERT expense ----------
      if (pathname === "/api/entries" && method === "POST") {
        const b = await request.json();
        if (!b.year || !b.month || !b.line_item_id) return bad("year, month, line_item_id required");
        const pid = await periodId(env, b.year, b.month);
        await env.DB.prepare(`INSERT INTO expense_entries (period_id, line_item_id, amount) VALUES (?, ?, ?)
          ON CONFLICT(period_id, line_item_id) DO UPDATE SET amount = excluded.amount`)
          .bind(pid, b.line_item_id, Number(b.amount) || 0).run();
        return json({ ok: true });
      }

      // ---------- BULK COPY entries between months ----------
      if (pathname === "/api/entries/copy" && method === "POST") {
        const b = await request.json();
        const sy = Number(b.source_year), sm = Number(b.source_month);
        const ty = Number(b.target_year), tm = Number(b.target_month);
        if (!sy || !sm || !ty || !tm) return bad("source_year, source_month, target_year, target_month required");
        if (sy === ty && sm === tm) return bad("source and target must be different");
        const fillEmpty = b.mode !== "overwrite";

        const srcRows = await env.DB.prepare(`
          SELECT ee.line_item_id, ee.amount
          FROM expense_entries ee
          JOIN periods p ON p.id = ee.period_id
          JOIN line_items li ON li.id = ee.line_item_id
          WHERE p.year = ? AND p.month = ? AND ee.amount > 0 AND li.active = 1
        `).bind(sy, sm).all();
        const srcEntries = srcRows.results || [];

        const skipIds = new Set();
        if (fillEmpty) {
          const tgtRows = await env.DB.prepare(`
            SELECT ee.line_item_id
            FROM expense_entries ee
            JOIN periods p ON p.id = ee.period_id
            WHERE p.year = ? AND p.month = ? AND ee.amount > 0
          `).bind(ty, tm).all();
          for (const r of (tgtRows.results || [])) skipIds.add(r.line_item_id);
        }

        const tgtPid = await periodId(env, ty, tm);

        // Snapshot prior amounts for the items that will be copied (for undo)
        const idsToCopy = srcEntries.filter(e => !skipIds.has(e.line_item_id)).map(e => e.line_item_id);
        let snapshot = [];
        if (idsToCopy.length > 0) {
          const placeholders = idsToCopy.map(() => '?').join(',');
          const priorRows = await env.DB.prepare(`
            SELECT line_item_id, amount FROM expense_entries
            WHERE period_id = ? AND line_item_id IN (${placeholders})
          `).bind(tgtPid, ...idsToCopy).all();
          const priorMap = new Map((priorRows.results || []).map(r => [r.line_item_id, Number(r.amount)]));
          snapshot = idsToCopy.map(id => ({ line_item_id: id, prior_amount: priorMap.get(id) || 0 }));
        }

        let copied = 0, skipped = 0;
        const stmts = [];
        for (const e of srcEntries) {
          if (skipIds.has(e.line_item_id)) { skipped++; continue; }
          stmts.push(env.DB.prepare(`
            INSERT INTO expense_entries (period_id, line_item_id, amount)
            VALUES (?, ?, ?)
            ON CONFLICT(period_id, line_item_id) DO UPDATE SET amount = excluded.amount
          `).bind(tgtPid, e.line_item_id, Number(e.amount)));
          copied++;
        }
        if (stmts.length > 0) await env.DB.batch(stmts);
        return json({ ok: true, copied, skipped, snapshot });
      }

      // ---------- BULK SET entries (used by undo + restores) ----------
      if (pathname === "/api/entries/bulk-set" && method === "POST") {
        const b = await request.json();
        if (!b.year || !b.month || !Array.isArray(b.items)) return bad("year, month, items[] required");
        if (b.items.length === 0) return json({ ok: true, updated: 0 });
        const pid = await periodId(env, b.year, b.month);
        const stmts = b.items.map(it => env.DB.prepare(`
          INSERT INTO expense_entries (period_id, line_item_id, amount)
          VALUES (?, ?, ?)
          ON CONFLICT(period_id, line_item_id) DO UPDATE SET amount = excluded.amount
        `).bind(pid, Number(it.line_item_id), Number(it.amount) || 0));
        await env.DB.batch(stmts);
        return json({ ok: true, updated: b.items.length });
      }

      // ---------- CLEAR month (set all active line items with amount > 0 to 0) ----------
      if (pathname === "/api/entries/clear" && method === "POST") {
        const b = await request.json();
        if (!b.year || !b.month) return bad("year, month required");
        const pid = await periodId(env, b.year, b.month);

        // Snapshot prior values for undo
        const priorRows = await env.DB.prepare(`
          SELECT ee.line_item_id, ee.amount
          FROM expense_entries ee
          JOIN line_items li ON li.id = ee.line_item_id
          WHERE ee.period_id = ? AND ee.amount > 0 AND li.active = 1
        `).bind(pid).all();
        const snapshot = (priorRows.results || []).map(r => ({
          line_item_id: r.line_item_id,
          prior_amount: Number(r.amount)
        }));

        // Set all to 0
        if (snapshot.length > 0) {
          const stmts = snapshot.map(s => env.DB.prepare(`
            UPDATE expense_entries SET amount = 0
            WHERE period_id = ? AND line_item_id = ?
          `).bind(pid, s.line_item_id));
          await env.DB.batch(stmts);
        }

        return json({ ok: true, cleared: snapshot.length, snapshot });
      }

      // ---------- UPSERT income ----------
      if (pathname === "/api/income" && method === "POST") {
        const b = await request.json();
        if (!b.year || !b.month || !b.contributor_id) return bad("year, month, contributor_id required");
        const pid = await periodId(env, b.year, b.month);
        const salary = b.salary !== undefined ? Number(b.salary) : Number(b.amount) || 0;
        await env.DB.prepare(`INSERT INTO income_entries (period_id, contributor_id, salary) VALUES (?, ?, ?)
          ON CONFLICT(period_id, contributor_id) DO UPDATE SET salary = excluded.salary`)
          .bind(pid, b.contributor_id, salary).run();
        return json({ ok: true });
      }

      // ---------- SHARE HISTORY ----------
      if (pathname === "/api/share-history" && method === "GET") {
        const rows = await env.DB.prepare(`
          SELECT sh.contributor_id, sh.share, sh.effective_year, sh.effective_month, c.name
          FROM share_history sh
          JOIN contributors c ON c.id = sh.contributor_id
          ORDER BY sh.effective_year DESC, sh.effective_month DESC, c.sort_order, c.id`).all();
        const groups = new Map();
        for (const r of rows.results) {
          const k = `${r.effective_year}-${r.effective_month}`;
          if (!groups.has(k)) groups.set(k, {
            effective_year: r.effective_year, effective_month: r.effective_month, shares: []
          });
          groups.get(k).shares.push({ contributor_id: r.contributor_id, name: r.name, share: r.share });
        }
        return json({ events: Array.from(groups.values()) });
      }

      if (pathname === "/api/share-history" && method === "POST") {
        const b = await request.json();
        if (!b.effective_year || !b.effective_month || !Array.isArray(b.shares) || b.shares.length === 0) {
          return bad("effective_year, effective_month, shares[] required");
        }
        const total = b.shares.reduce((s, x) => s + Number(x.share), 0);
        if (Math.abs(total - 1) > 0.001) return bad(`Shares must sum to 1.0 (got ${total.toFixed(4)})`);
        const stmts = b.shares.map(s => env.DB.prepare(
          `INSERT INTO share_history (contributor_id, share, effective_year, effective_month)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(contributor_id, effective_year, effective_month) DO UPDATE SET share = excluded.share`
        ).bind(s.contributor_id, Number(s.share), b.effective_year, b.effective_month));
        await env.DB.batch(stmts);
        return json({ ok: true });
      }

      const shMatch = pathname.match(/^\/api\/share-history\/(\d+)\/(\d+)$/);
      if (shMatch && method === "DELETE") {
        const yr = Number(shMatch[1]);
        const mo = Number(shMatch[2]);
        // Don't allow deleting if it's the only event left
        const remain = await env.DB.prepare(
          `SELECT COUNT(DISTINCT effective_year || '-' || effective_month) AS n FROM share_history`
        ).first();
        if (remain.n <= 1) return bad("Cannot delete the only share entry — at least one must remain.");
        await env.DB.prepare(
          `DELETE FROM share_history WHERE effective_year = ? AND effective_month = ?`
        ).bind(yr, mo).run();
        return json({ ok: true });
      }

      // ---------- CREATE line item ----------
      if (pathname === "/api/line-items" && method === "POST") {
        const b = await request.json();
        if (!b.category_id || !b.name) return bad("category_id & name required");
        const name = String(b.name).trim();
        const note = b.note || "";
        const isPersonal = b.is_personal ? 1 : 0;
        const assignedContributorId = b.assigned_contributor_id || null;

        // Personal items REQUIRE an assigned contributor
        if (isPersonal && !assignedContributorId) return bad("personal items require assigned_contributor_id");

        // Check if an item with same name+category already exists.
        // If archived (active=0), RESURRECT it (set active=1, refresh fields).
        // If active (active=1), return a clear error.
        const existing = await env.DB.prepare(
          "SELECT id, active FROM line_items WHERE category_id = ? AND name = ? LIMIT 1"
        ).bind(b.category_id, name).first();

        if (existing) {
          if (existing.active === 1) {
            return bad(`"${name}" already exists in this category`);
          }
          await env.DB.prepare(
            "UPDATE line_items SET active = 1, note = ?, is_personal = ?, assigned_contributor_id = ? WHERE id = ?"
          ).bind(note, isPersonal, assignedContributorId, existing.id).run();
          return json({ ok: true, id: existing.id, restored: true });
        }

        const r = await env.DB.prepare(
          "INSERT INTO line_items (category_id, name, note, is_personal, assigned_contributor_id) VALUES (?, ?, ?, ?, ?)"
        ).bind(b.category_id, name, note, isPersonal, assignedContributorId).run();
        return json({ ok: true, id: r.meta.last_row_id, restored: false });
      }

      // ---------- PATCH line item ----------
      const liMatch = pathname.match(/^\/api\/line-items\/(\d+)$/);
      if (liMatch && method === "PATCH") {
        const id = Number(liMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["name", "note", "active", "category_id", "sort_order", "is_personal", "assigned_contributor_id"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE line_items SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }

      // ---------- BATCH REORDER line items ----------
      if (pathname === "/api/line-items/reorder" && method === "POST") {
        const updates = await request.json();
        if (!Array.isArray(updates) || updates.length === 0) return bad("array of {id, sort_order} required");
        const stmts = updates.map(u =>
          env.DB.prepare("UPDATE line_items SET sort_order = ? WHERE id = ?")
            .bind(Number(u.sort_order), Number(u.id)));
        await env.DB.batch(stmts);
        return json({ ok: true });
      }

      // ---------- PATCH category ----------
      const catMatch = pathname.match(/^\/api\/categories\/(\d+)$/);
      if (catMatch && method === "PATCH") {
        const id = Number(catMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["name", "icon", "sort_order", "active"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }

      // ---------- DELETE category (cascade: archive all line items inside it) ----------
      if (catMatch && method === "DELETE") {
        const id = Number(catMatch[1]);
        // Cascade archive line items + the category itself
        await env.DB.batch([
          env.DB.prepare("UPDATE line_items SET active = 0 WHERE category_id = ?").bind(id),
          env.DB.prepare("UPDATE categories SET active = 0 WHERE id = ?").bind(id)
        ]);
        return json({ ok: true });
      }

      // ---------- BATCH REORDER categories ----------
      if (pathname === "/api/categories/reorder" && method === "POST") {
        const updates = await request.json();
        if (!Array.isArray(updates) || updates.length === 0) return bad("array of {id, sort_order} required");
        const stmts = updates.map(u =>
          env.DB.prepare("UPDATE categories SET sort_order = ? WHERE id = ?")
            .bind(Number(u.sort_order), Number(u.id)));
        await env.DB.batch(stmts);
        return json({ ok: true });
      }

      // ============================================================
      // SAVINGS MODULE
      // ============================================================

      // ---------- BOOTSTRAP: accounts + snapshots + goals + insights ----------
      if (pathname === "/api/savings/bootstrap" && method === "GET") {
        const [accounts, snapshots, goals] = await Promise.all([
          env.DB.prepare("SELECT * FROM savings_accounts WHERE active = 1 ORDER BY id").all(),
          env.DB.prepare("SELECT * FROM savings_snapshots ORDER BY snapshot_date DESC, id DESC LIMIT 120").all(),
          env.DB.prepare("SELECT * FROM savings_goals WHERE active = 1 ORDER BY priority, id").all()
        ]);

        // Compute insights from snapshots
        const snaps = (snapshots.results || []).slice().reverse(); // chronological
        const byAcct = {};
        for (const s of snaps) {
          if (!byAcct[s.account_id]) byAcct[s.account_id] = [];
          byAcct[s.account_id].push(s);
        }

        // Aggregate-level insights (per primary account = id=1 if exists, else first account)
        const acctList = accounts.results || [];
        const primary = acctList.find(a => a.id === 1) || acctList[0];
        const insights = { bestMonth: null, targetHitRate: null, avgMonthlySave: null, goalEta: null };

        if (primary && byAcct[primary.id]) {
          const acctSnaps = byAcct[primary.id];
          const contribs = acctSnaps.filter(s => s.contributed != null && s.contributed !== '').map(s => ({
            ym: s.snapshot_date.slice(0, 7),
            contributed: Number(s.contributed)
          }));
          // Group by month (last snapshot per month wins for contributed)
          const monthMap = {};
          for (const c of contribs) monthMap[c.ym] = c.contributed;
          const months = Object.entries(monthMap).map(([ym, v]) => ({ ym, v }));

          if (months.length) {
            // Best month (highest contribution)
            const best = months.reduce((a, b) => b.v > a.v ? b : a);
            insights.bestMonth = { ym: best.ym, amount: best.v };

            // Avg monthly save (over all months with data)
            const avg = months.reduce((s, m) => s + m.v, 0) / months.length;
            insights.avgMonthlySave = avg;

            // Target hit rate
            const target = Number(primary.monthly_target || 0);
            if (target > 0) {
              const hit = months.filter(m => m.v >= target).length;
              insights.targetHitRate = { hit, total: months.length, pct: (hit / months.length) * 100 };
            }
          }
        }

        // ETA per goal — at current avg pace, how many months until allocated balance reaches target
        // SCHEDULED goals (with start_date in the future) don't consume balance until they activate.
        const currentBalanceByAcct = {};
        for (const a of acctList) {
          const arr = byAcct[a.id];
          currentBalanceByAcct[a.id] = (arr && arr.length) ? Number(arr[arr.length - 1].balance) : 0;
        }
        const totalBalance = Object.values(currentBalanceByAcct).reduce((s, v) => s + v, 0);
        const todayStr = new Date().toISOString().slice(0, 10);
        let allocated = 0;
        const goalsWithProgress = (goals.results || []).map(g => {
          const isScheduled = g.start_date && g.start_date > todayStr;
          if (isScheduled) {
            // Scheduled goal: no balance allocated, sits in list with countdown
            return { ...g, allocated: 0, is_scheduled: true };
          }
          // Active goal: allocate by priority
          const remaining = Math.max(0, totalBalance - allocated);
          const filled = Math.min(remaining, g.target_amount);
          allocated += g.target_amount;
          return { ...g, allocated: filled, is_scheduled: false };
        });

        // Use first un-finished ACTIVE goal for ETA insight (scheduled goals don't have a pace yet)
        const firstActiveGoal = goalsWithProgress.find(g => !g.is_scheduled && g.allocated < g.target_amount);
        if (firstActiveGoal && insights.avgMonthlySave > 0) {
          const need = firstActiveGoal.target_amount - firstActiveGoal.allocated;
          const months = Math.ceil(need / insights.avgMonthlySave);
          const eta = new Date();
          eta.setMonth(eta.getMonth() + months);
          insights.goalEta = {
            name: firstActiveGoal.name,
            months_at_pace: months,
            eta_year: eta.getFullYear(),
            eta_month: eta.getMonth() + 1
          };
        }

        return json({
          accounts: acctList,
          snapshots: snapshots.results || [],
          goals: goalsWithProgress,
          insights,
          total_balance: totalBalance
        });
      }

      // ---------- CREATE ACCOUNT ----------
      if (pathname === "/api/savings/accounts" && method === "POST") {
        const b = await request.json();
        if (!b.name || !b.contributor_id) return bad("name + contributor_id required");
        const res = await env.DB.prepare(
          "INSERT INTO savings_accounts (contributor_id, name, type, monthly_target, opened_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(b.contributor_id, b.name, b.type || null, b.monthly_target || 0, b.opened_at || null).run();
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      // ---------- PATCH / DELETE ACCOUNT ----------
      const acctMatch = pathname.match(/^\/api\/savings\/accounts\/(\d+)$/);
      if (acctMatch && method === "PATCH") {
        const id = Number(acctMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["name", "type", "monthly_target", "opened_at", "active"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE savings_accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }
      if (acctMatch && method === "DELETE") {
        const id = Number(acctMatch[1]);
        await env.DB.prepare("UPDATE savings_accounts SET active = 0 WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---------- CREATE / PATCH / DELETE SNAPSHOT ----------
      if (pathname === "/api/savings/snapshots" && method === "POST") {
        const b = await request.json();
        if (!b.account_id || !b.snapshot_date || b.balance == null) return bad("account_id, snapshot_date, balance required");
        const res = await env.DB.prepare(
          "INSERT INTO savings_snapshots (account_id, snapshot_date, balance, contributed, note) VALUES (?, ?, ?, ?, ?)"
        ).bind(b.account_id, b.snapshot_date, b.balance, b.contributed ?? null, b.note || null).run();
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      const snapMatch = pathname.match(/^\/api\/savings\/snapshots\/(\d+)$/);
      if (snapMatch && method === "PATCH") {
        const id = Number(snapMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["snapshot_date", "balance", "contributed", "note"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE savings_snapshots SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }
      if (snapMatch && method === "DELETE") {
        const id = Number(snapMatch[1]);
        await env.DB.prepare("DELETE FROM savings_snapshots WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---------- CREATE / PATCH / DELETE GOAL ----------
      if (pathname === "/api/savings/goals" && method === "POST") {
        const b = await request.json();
        if (!b.name || !b.target_amount) return bad("name + target_amount required");
        // Priority defaults to end of list
        const maxP = await env.DB.prepare("SELECT MAX(priority) AS p FROM savings_goals WHERE active = 1").first();
        const priority = b.priority ?? (Number(maxP?.p || 0) + 1);
        const res = await env.DB.prepare(
          "INSERT INTO savings_goals (account_id, name, target_amount, target_date, icon, color, priority, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(b.account_id || null, b.name, b.target_amount, b.target_date || null, b.icon || 'Target', b.color || 'var(--cyan)', priority, b.start_date || null).run();
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      const goalMatch = pathname.match(/^\/api\/savings\/goals\/(\d+)$/);
      if (goalMatch && method === "PATCH") {
        const id = Number(goalMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["name", "target_amount", "target_date", "icon", "color", "priority", "active", "start_date"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE savings_goals SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }
      if (goalMatch && method === "DELETE") {
        const id = Number(goalMatch[1]);
        await env.DB.prepare("UPDATE savings_goals SET active = 0 WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---------- START NEW YEAR (carry forward wizard) ----------
      if (pathname === "/api/start-new-year" && method === "POST") {
        const b = await request.json();
        const targetYear = Number(b.target_year);
        if (!targetYear || targetYear < 2020 || targetYear > 2100) return bad("invalid target_year");

        // Validate body fields
        const items = Array.isArray(b.items) ? b.items : [];
        const archives = Array.isArray(b.archive_ids) ? b.archive_ids : [];
        const newShares = Array.isArray(b.new_shares) ? b.new_shares : null;

        const stmts = [];

        // 1) Create all 12 period rows for the target year (idempotent)
        for (let m = 1; m <= 12; m++) {
          stmts.push(env.DB.prepare(
            "INSERT OR IGNORE INTO periods (year, month) VALUES (?, ?)"
          ).bind(targetYear, m));
        }

        // 2) Archive line items the user marked as "ended"
        for (const id of archives) {
          stmts.push(env.DB.prepare(
            "UPDATE line_items SET active = 0 WHERE id = ?"
          ).bind(Number(id)));
        }

        await env.DB.batch(stmts);

        // 3) Insert January expense_entries as the starting template.
        //    We need period_id which we now know exists; fetch the Jan period id.
        const janRow = await env.DB.prepare(
          "SELECT id FROM periods WHERE year = ? AND month = 1"
        ).bind(targetYear).first();
        if (!janRow) return bad("Failed to create periods");

        const expenseStmts = [];
        for (const it of items) {
          if (!it.line_item_id || it.amount == null) continue;
          const amt = Number(it.amount);
          if (!isFinite(amt) || amt < 0) continue;
          expenseStmts.push(env.DB.prepare(
            `INSERT INTO expense_entries (period_id, line_item_id, amount)
             VALUES (?, ?, ?)
             ON CONFLICT(period_id, line_item_id) DO UPDATE SET amount = excluded.amount`
          ).bind(janRow.id, Number(it.line_item_id), amt));
        }
        if (expenseStmts.length) await env.DB.batch(expenseStmts);

        // 4) Optionally create a new share_history entry for January
        if (newShares && newShares.length) {
          const total = newShares.reduce((s, x) => s + Number(x.share), 0);
          if (Math.abs(total - 1) > 0.001) return bad("new_shares must sum to 1.0");
          const shareStmts = newShares.map(s => env.DB.prepare(
            `INSERT INTO share_history (contributor_id, share, effective_year, effective_month)
             VALUES (?, ?, ?, 1)
             ON CONFLICT(contributor_id, effective_year, effective_month) DO UPDATE SET share = excluded.share`
          ).bind(s.contributor_id, Number(s.share), targetYear));
          await env.DB.batch(shareStmts);
        }

        return json({
          ok: true,
          target_year: targetYear,
          items_inserted: expenseStmts.length,
          items_archived: archives.length,
          shares_set: newShares ? newShares.length : 0
        });
      }

      // ---------- INSTALLMENTS ----------
      if (pathname === "/api/installments" && method === "GET") {
        const rows = await env.DB.prepare(`SELECT i.*, c.name AS buyer_name
          FROM installments i
          LEFT JOIN contributors c ON c.id = i.buyer_id
          ORDER BY
            CASE i.status WHEN 'active' THEN 1 WHEN 'overdue' THEN 2 ELSE 3 END,
            i.created_at DESC`).all();
        return json({ installments: rows.results });
      }

      if (pathname === "/api/installments" && method === "POST") {
        const b = await request.json();
        if (!b.name || b.total_amount == null || b.monthly_payment == null
            || !b.num_months || !b.start_year || !b.start_month) {
          return bad("name, total_amount, monthly_payment, num_months, start_year, start_month required");
        }
        const r = await env.DB.prepare(`INSERT INTO installments
          (name, category, buyer_id, icon, color, total_amount, monthly_payment, num_months,
           start_year, start_month, paid_amount, status, notes, due_day)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            b.name, b.category || '', b.buyer_id || null, b.icon || 'Box',
            b.color || 'var(--cyan)', Number(b.total_amount), Number(b.monthly_payment),
            Number(b.num_months), Number(b.start_year), Number(b.start_month),
            Number(b.paid_amount) || 0, b.status || 'active', b.notes || '',
            (b.due_day != null ? Number(b.due_day) : 1)
          ).run();
        return json({ ok: true, id: r.meta.last_row_id });
      }

      const instMatch = pathname.match(/^\/api\/installments\/(\d+)$/);
      if (instMatch && method === "PATCH") {
        const id = Number(instMatch[1]);
        const b = await request.json();
        const sets = [], vals = [];
        for (const f of ["name","category","buyer_id","icon","color","total_amount",
                          "monthly_payment","num_months","start_year","start_month",
                          "paid_amount","status","notes","paid_at_year","paid_at_month","due_day"]) {
          if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
        }
        if (!sets.length) return bad("nothing to update");
        vals.push(id);
        await env.DB.prepare(`UPDATE installments SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      }

      // ---------- LOG / UNLOG monthly payment ----------
      const payMatch = pathname.match(/^\/api\/installments\/(\d+)\/pay$/);
      if (payMatch && method === "POST") {
        const id = Number(payMatch[1]);
        const row = await env.DB.prepare(
          "SELECT monthly_payment, total_amount, paid_amount, status FROM installments WHERE id = ?"
        ).bind(id).first();
        if (!row) return bad("Installment not found", 404);

        const newPaid = Number(row.paid_amount || 0) + Number(row.monthly_payment);
        const capped = Math.min(newPaid, Number(row.total_amount));
        const fullyPaid = capped >= Number(row.total_amount);
        const newStatus = fullyPaid ? 'paid' : (row.status === 'paid' ? 'active' : row.status);

        // Stamp paid_at on the month this transition happened (today)
        const now = new Date();
        const paidYear = fullyPaid ? now.getFullYear() : null;
        const paidMonth = fullyPaid ? now.getMonth() + 1 : null;
        const todayStr = now.toISOString().slice(0, 10);

        if (fullyPaid) {
          await env.DB.prepare(
            "UPDATE installments SET paid_amount = ?, status = ?, paid_at_year = ?, paid_at_month = ?, last_paid_date = ? WHERE id = ?"
          ).bind(capped, newStatus, paidYear, paidMonth, todayStr, id).run();
        } else {
          await env.DB.prepare(
            "UPDATE installments SET paid_amount = ?, status = ?, last_paid_date = ? WHERE id = ?"
          ).bind(capped, newStatus, todayStr, id).run();
        }
        return json({ ok: true, paid_amount: capped, status: newStatus });
      }

      if (payMatch && method === "DELETE") {
        const id = Number(payMatch[1]);
        const row = await env.DB.prepare(
          "SELECT monthly_payment, total_amount, paid_amount, status FROM installments WHERE id = ?"
        ).bind(id).first();
        if (!row) return bad("Installment not found", 404);

        const newPaid = Math.max(0, Number(row.paid_amount || 0) - Number(row.monthly_payment));
        const wasPaid = row.status === 'paid';
        const newStatus = newPaid < Number(row.total_amount) && wasPaid ? 'active' : row.status;
        // If reverting from paid, clear the paid_at stamp
        if (wasPaid && newStatus !== 'paid') {
          await env.DB.prepare(
            "UPDATE installments SET paid_amount = ?, status = ?, paid_at_year = NULL, paid_at_month = NULL, last_paid_date = NULL WHERE id = ?"
          ).bind(newPaid, newStatus, id).run();
        } else {
          await env.DB.prepare(
            "UPDATE installments SET paid_amount = ?, status = ?, last_paid_date = NULL WHERE id = ?"
          ).bind(newPaid, newStatus, id).run();
        }
        return json({ ok: true, paid_amount: newPaid, status: newStatus });
      }

      if (instMatch && method === "DELETE") {
        const id = Number(instMatch[1]);
        await env.DB.prepare(`DELETE FROM installments WHERE id = ?`).bind(id).run();
        return json({ ok: true });
      }

      // ---------- LOANS (Car / House) ----------
      if (pathname === "/api/loans" && method === "GET") {
        const rows = await env.DB.prepare(`SELECT * FROM loans WHERE active = 1 ORDER BY kind, sort_order, id`).all();
        return json({ loans: rows.results || [] });
      }

      const loanMatch = pathname.match(/^\/api\/loans\/(\d+)$/);
      if (loanMatch && method === "PATCH") {
        const id = Number(loanMatch[1]);
        const b = await request.json();
        const fields = ['name','purchase_price','down_payment','principal','monthly_payment','rate','rate_type','tenure_months','start_year','start_month','bank','account_no','photo_url','metadata','snapshot_paid','snapshot_outstanding','snapshot_date','due_day','notes','sort_order','active'];
        const updates = [];
        const params = [];

        // If any snapshot_* field is being changed, copy current → prev_* first (undo buffer).
        const touchesSnapshot = ['snapshot_paid','snapshot_outstanding','snapshot_date'].some(k => b[k] !== undefined);
        if (touchesSnapshot) {
          const cur = await env.DB.prepare(`SELECT snapshot_paid, snapshot_outstanding, snapshot_date FROM loans WHERE id = ?`).bind(id).first();
          if (cur) {
            updates.push(`prev_snapshot_paid = ?`);          params.push(cur.snapshot_paid);
            updates.push(`prev_snapshot_outstanding = ?`);   params.push(cur.snapshot_outstanding);
            updates.push(`prev_snapshot_date = ?`);          params.push(cur.snapshot_date);
          }
        }

        for (const f of fields) {
          if (b[f] !== undefined) {
            updates.push(`${f} = ?`);
            params.push(b[f]);
          }
        }
        if (updates.length === 0) return bad("no fields to update");
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        params.push(id);
        await env.DB.prepare(`UPDATE loans SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
        return json({ ok: true });
      }

      // POST /api/loans/:id/undo — swap prev_snapshot_* → current; clear prev_*
      const undoMatch = pathname.match(/^\/api\/loans\/(\d+)\/undo$/);
      if (undoMatch && method === "POST") {
        const id = Number(undoMatch[1]);
        const cur = await env.DB.prepare(`SELECT prev_snapshot_paid, prev_snapshot_outstanding, prev_snapshot_date FROM loans WHERE id = ?`).bind(id).first();
        if (!cur) return bad("loan not found", 404);
        if (cur.prev_snapshot_paid === null && cur.prev_snapshot_outstanding === null && cur.prev_snapshot_date === null) {
          return bad("nothing to undo", 400);
        }
        await env.DB.prepare(`UPDATE loans SET
          snapshot_paid = ?, snapshot_outstanding = ?, snapshot_date = ?,
          prev_snapshot_paid = NULL, prev_snapshot_outstanding = NULL, prev_snapshot_date = NULL,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`)
          .bind(cur.prev_snapshot_paid, cur.prev_snapshot_outstanding, cur.prev_snapshot_date, id)
          .run();
        return json({ ok: true, restored: { snapshot_paid: cur.prev_snapshot_paid, snapshot_outstanding: cur.prev_snapshot_outstanding, snapshot_date: cur.prev_snapshot_date } });
      }

      // ---------- PWA: manifest ----------
      if (pathname === "/manifest.json" && method === "GET") {
        return new Response(JSON.stringify({
          name: "moneyallmatters",
          short_name: "MAM",
          description: "Household finance command center",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "var(--bg)",
          theme_color: "var(--bg)",
          orientation: "portrait",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
          ]
        }), {
          headers: {
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=86400"
          }
        });
      }

      // ---------- PWA: service worker (app shell cache) ----------
      if (pathname === "/sw.js" && method === "GET") {
        return new Response(SW_JS, {
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store",
            "service-worker-allowed": "/"
          }
        });
      }

      // ---------- PWA: PNG icons (iOS requires PNG for apple-touch-icon) ----------
      if (pathname === "/apple-touch-icon.png" && method === "GET") {
        return new Response(b64ToBytes(PNG_180), {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" }
        });
      }
      if (pathname === "/icon-192.png" && method === "GET") {
        return new Response(b64ToBytes(PNG_192), {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" }
        });
      }
      if (pathname === "/icon-512.png" && method === "GET") {
        return new Response(b64ToBytes(PNG_512), {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" }
        });
      }

      // ---------- PWA: app icon (Radar logo on dark plate) ----------
      if (pathname === "/icon.svg" && method === "GET") {
        return new Response(ICON_SVG, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=2592000"
          }
        });
      }

      return bad("Not found", 404);
    } catch (err) {
      return json({ error: String(err?.message || err), stack: err?.stack }, 500);
    }
  },
};

// ============================================================
//  PWA assets (referenced by routes above)
// ============================================================
const SW_JS = `const CACHE='mam-shell-v1';
const SHELL=['/'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  if(url.pathname.startsWith('/api/'))return;
  if(url.pathname.startsWith('/cdn-cgi/'))return;
  if(url.origin!==location.origin && !/(unpkg|jsdelivr|fonts\\.googleapis|fonts\\.gstatic)/.test(url.host))return;
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r.ok){
        const clone=r.clone();
        caches.open(CACHE).then(c=>c.put(e.request,clone)).catch(()=>{});
      }
      return r;
    }).catch(()=>caches.match(e.request).then(r=>r||caches.match('/')))
  );
});`;

const ICON_SVG = `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="22" fill="var(--bg)"/>
  <circle cx="60" cy="60" r="42" fill="none" stroke="var(--cyan)" stroke-width="2" opacity="0.6"/>
  <circle cx="60" cy="60" r="30" fill="none" stroke="var(--cyan)" stroke-width="1" opacity="0.25"/>
  <circle cx="60" cy="60" r="18" fill="none" stroke="var(--cyan)" stroke-width="1" opacity="0.15"/>
  <line x1="60" y1="20" x2="60" y2="100" stroke="var(--cyan)" stroke-width="0.5" opacity="0.2"/>
  <line x1="20" y1="60" x2="100" y2="60" stroke="var(--cyan)" stroke-width="0.5" opacity="0.2"/>
  <path d="M60 60 L60 20 A40 40 0 0 1 92 38 Z" fill="var(--cyan)" opacity="0.10"/>
  <polyline points="24,60 38,60 43,42 48,72 53,49 58,60 64,56 70,64 76,60 96,60" fill="none" stroke="var(--teal)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="60" cy="60" r="4" fill="var(--cyan)"/>
  <circle cx="60" cy="60" r="2" fill="var(--bg)"/>
  <circle cx="74" cy="40" r="3.2" fill="var(--pink)" opacity="0.9"/>
  <circle cx="74" cy="40" r="6" fill="none" stroke="var(--pink)" stroke-width="1" opacity="0.45"/>
</svg>`;
// PNG icons for iOS apple-touch-icon and Android manifest (base64-encoded)
const PNG_180 = "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";
const PNG_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAABmJLR0QA/wD/AP+gvaeTAAAgAElEQVR4nO2dd3xk13Xff/e+Mh2DMui7WGzB9s7dpXZZlpRIihRVSEqUKZmmJZc4jhImURxLsR1HdhLLiRI7tmR9bMVRsyRSxZIsS6REiRR75zaSW7DAAovFLtqgDKa/cm/+uNMeMAAGmDcFu/P9fPjhvIc39915e8+759x7CkEZcfhbNnKDHaIEW8GxBcAmTtAAjjoAHgCucvanRsWIAggBmAEwAU7eJOCnTPATemzyOACjXB0hpW1+jUv1Jt8HjvcQ8FsBdJX2fjVWOwSYBvA4I+RHmmo+jqmp2RLfz35crpYjTGIfB8f9APyluEeNa4IwOPk6JP75ZDh4rhQ3sFUAHJ7mO8H5H4LgRjvbrXHNwwH8hEP6Ay069qadDdsiAC5X0/Wcks9z4KAd7dWosQAmgK9KHH8ciwWv2NFgcQLg9zc4DPkzAPkEAMmODtWoUQCzhOM/JmLBLxXb0IoFwOkNHOUc3wLQUWwnatRYIY9LHL9VzGxAV/AdonqaPsU5nkRt8NeoLHeZBK8rrqZDK21gmWrLJofDTR4hhDyMlQlPjRp24yOEPKSoriFDj59c7pcLF4CGBr9D0h4DIXct9yY1apQYGSD3SKorYerxF5bzxcIEoKHB79CkXwJ4x0p6V6NGGSAE5DZJ8RimHnuu0C8VIADdTodk/AS1wV9jFUAI3ikpbmbqsWcLuX4pAZAcXvk7AO4svms1apQHQnCronguGXrs+FLXLmrIqu7AH4HjHvu6VqNGeeCE/63T03TbUtctuA/g9AZu5Rw/R22Dq8bqZYaY0nWJxNiFhS7IPwPU1TVyjm+iNvhrrG7qmWR+C4Cy0AV5B7hD8f0fALeUqFM1apQNAqxRVI9s6LEnF/i7FZer6XpGyYuobXTVuHpglPEj8fjkK3P/MG+Qc0o+n+98jRqrGMoo+SLyaDyWge5wN99Vc2mucZWy3+Ft+p25Jy0qkMMdeK4WzFLjaoWDTGpudGNiIpI+l5kBXK6WI7XBX+NqhoA3qTH2idxzGQFgEvt4+btUo0Z5ISC/h+Zmb/o4JQBrXKkA9ho1rnYCjih/MH1AAUD1Jt+PWvaGGtcIhOA30p/FDMBR8/Gvcc3AgYOKp3kvkBKAVNKqGjWuGSTgwwBAHP6WjTBYX6U7dFUhSaB1flB/A2hdPajPB+Jyg7hc4v9UAiQJRBUuKlzTAdMEZyZ4PAYej4PHY2DhMFhoBiw0DRYOAaZZ4R92VXE8GQ3ul7nBDpU4P+JVDVFVSO1rIHV0Qmppg9zSBtoQAKjNm+mMgU1NwJgYgzk2CvPKMMyRYXBdt/c+1w573e5Au0wJtnBe6b6sHogkQ1rbDWXDJsjruiE1t9s/2PNBKWigFWqgFdi2W5xjDOb4CIyhQegXzsO8dBHcLFte2dUOMSi5SQbH1kr3pNohDgfknm1Qt+yAvH4jiLygd60Fbupg00J94fEYeCwGnoiDGwbAGLiWFO2rDoBSEFkGcbpA3G5QlwfEVwfa0AAiLXA/SiG1dUJq64Tj0A3ghg5joB/a2bdgnD8Drml2PYKrEgq2mzg9gdc5cF2lO1N1EAplYw/U3ddB3tgDIskLX5t+E4+OwBwfARsfA5sKgsWitnSFur2gTQHQ5lahZrW1Q2pZfObhpg69vxf6yWPQL/QBnNnSl6sKgh8RhzfQD44Nle5LtUA9PqjXHYK6ez+oty7/RZzBuDIMY6APxtAgzJHL4Pry37akvgG0sQk8NA0wDs4YCOcZgximCW6aeY1foiiQ2tdA7uqGsqEHUnsnQPILBAuHoJ06Bu3Ya2DR8LL7eRVzmjg8gQkAgUr3pNJILW1wHDoCdftugM6PE0q/UY2zb0O/0AeeiBd9z4wAzIYWv5BzcMMA0Q1wUwPXhQplacvlgrK+B8q2nZA35J+xODOgvf0mkq++ADYxVnT/rwKuEIcnEAfgrHRPKoXU0gbnje+Esnkr5scHcRhDg0iefKMkOnXBApAHbuggmg6ua/NWgoiqQt68HY7d+yF3dSPf79J6TyPx3C+vdUGIEocncE2uAdH6BjhvuR3qlp0AsQ4QnkxAO/EakifeAJueLFkfihEAC4wBySS4lpwnDLSxCY49B6DuOyiM7Vw4h3bmTSSe+QVYaLq4PqxSrjkBIKoK55FboB46DEKtaoIZmob22kvQTr1RlhUU2wQgF9METyTAkwmLmkRUFeqeA3AcPAxaV2/5CjcNJF99AcmXnr3mVo6uKQFQt+yA8467QT0+y3k2O4PEi89AO3UcYOXbbS2JAKThXMwK6WXXNJIEdfd+OI8cBfVZ/R9ZZBbxJ34MvfeM/f2pUq4JAaDeOrje/V4oPdss53kyjsTzT0M79mpFNpBKKgC5aJrYgzCy6hGRZKjXXQ/nDbeAOKwmoHbubSSe+DFYNDK3pauOq14A1K074LrzAyDOnAqsnEE7/jrizz0JHo9VrG9lE4A0mgYei1pmBOrywHn0XVD3XGdZRuWJGGKP/fCqnw2uWgEgqgrnbXfDsXu/5bw5MYrYYz+EOXK5Qj3LUnYBSJNIiE26HBtB6lgD93vugRRotVyaPPk6Er947Kr1OboqBYA2BuC57yOQAi3Zk8xE4vlfIvHy82XV8xejYgIAAJyBR6PgiUT2HJXgPHwTnDfeApDsXogZHEP0Hx8p6YpYpbjqBEDZvA3u937QsuRnTgYR++fvwhy1pbCgbVRUAFJwXQePhC27zVJ7J9zvux9SY1P2Oi2J2D9/D/r5s5XoZsmQZNX9mUp3wi4c77gJ7rs+YNkFTZ46htj3vwU2O1PBnuWHOEV8AJLJyvVBkkCcTgAcSNkGPBKGfuoN0Lo64XOElNG8bRe4ocO8PFSx/trN1SEAhMJ9x3vhPHwz0ruenBlIPPlTJJ75edWoPHOpBgEQHSEgqgoiK0LX5xxgDHrvGbBIGMqGHmEgEwJl/SaQOj+M/vPiulXOqhcAIsnw3PsA1J17MudYNILot78G/dzpCvZsaapGANJIEojDAeT4GpmjV2AMXoDcsxVEUQEAcmsHpOZWGL1nVr2X6aoWAKKo8Hzwo1A2bs6cM4PjiD7yFbDgeAV7VhhVJwAAQKgQAm4Chpg5WTgE/ezbkDdsAnV7AABSUzPkteugn3t7VYdqrlojmCgqPPc/CLlrfeaccWkQ0X/8pnVlo5IQCuJ0gDicYrDLCiBJAJVAJCqMYH89eGgGnDHx1jVNcFMX7gxaEjypVe4tG4tZYhqIywXPhx6E3NmVOWcMDSD63W+syB28GlidAiBJ8NxnffMbQwOIfu8bFfVlIQ4HiLcO1FsH4vUKlWGOox04z/j6U48X1O8Xg4xKIlg+3/WGBh6NgUXD4NFweX9jIgkWmc0ciln3I5C7N2XOGYP9QghWYTjm6hMASuG59yNQerKRnHp/L2Lff6Qi/wDUWwfa0ARS5wdRhY4MzsSOazwOnkyAJRJAMi4Gbo7hmHcZlBAQRQEcTlCHSxinTqdQlVI7tVxPgocjIltEOQJcNA0sPJvpO5FluO/9iOUFpJ8/g+j3H111NsGqEwD3He+Duv9Q5tgY7BdvfqN8g584naCNTaCNzeItzzl4PAoWngUPh8WgZEsPhGXtA1AK6vaCeDygXh+I0w0QAm5oYNOTYDPT4KW0JTRdpGZJC7AkwfPBXxUrRCmSJ19H/PF/Kl0fSsCqEgDH4ZvgOnpH5tgYvojot79eNv2Ten2Q2jpA0l6UiRjMyUmw6cniQiJXsBFGZAW0oRFSfSOQcmbjkVmYE2Olc2KbIwREUeB54GMWmyD+1E+RfHVZxdoryqpZBVI2b4P7rg8gvc5vBscRffSrmcwKpYTW1UNetx5SWyeIooIFx2FcSsUCRyMr3mcoahWICTXLnAoKAeJcJOFqDIB6fYBu2P9sJAlEkrPtpvYKlJ5toG43AEDp3ghz7ArY1Opwm1gVAkAbm+D98EOZHV4Wj4rBHymt/kucbigbNkFq7QCRZJjBUZgD/WAzU4BRvHOYXcug3DCEoTozjWbVhVZ/K9qb18DnbwJJJhHXio9fziALYz1jiBsGjP5eKDt2ZYx+pWcr9N7TFfW0LZSqV4GIqsL70O9kHNs4MxD5xv+DeWW4dDeVJJFvp7kV4BzmxAjY2JjtRrZdvkB+1YXrGrrQ7QnAKSnCXvB4QNxegBDMzk6id6QfxycvImHa49XJo1HLAJc7u+D91d/IJBQwg2OIfO3vqt6LtOpnANedH4CyPrvkFv/pP8PoK51DFvHXQ9m0FdTnBw+HYFzoBZuZLsnqRrEzACEERwIbcFvrNjQ5fBhNhHBqZhhvzVzGqfELGJy+ghkJ8Pka0RNYix2eFsS0OILJ4m0EoqqAaWQ2wVg4BBaPZ1aGqNsL4vbA6DtX9L1KSVULgLp1B1xHb88cJ08dQ/L5p0pzM0Igd3ZBXrMOME2YQxdEzEAJdzmLEQCZUNzdsQtb6towFJvC4yNv4dTMMMYTYYT0OKJGEtOJCC5PDOP07BWMumS0+Vuwo64NimHiUmyq+P6rjtTSbsptYuSyMMxb2kQf2zpgjo+CTQaLvlepqFoBoN46eD78UCYNoTkZROz73yqJYxtRVSgbt4A2NIKHZmD0nwOPlV5/LUYAbmvfhvWeAF6fuoinx88tqtrwZBKhyVGcJwk01jdje+NaGFoCI9EiM0EQAiiKpf/GYD+UrTtBXcIolrs3Qn/rRNXuFFdtPWDXu9+bDWPkJmI/+V5JHiL1+SFv3Smm68tD0C/0lnVPYSVsr+vAJm8L3pwZxquTA/P+7pIUNDt9UHOzXpgmEhf78UTfqxghOo70HEJrY3vRfSGyDOrJlNwC1zTE/um7mRcVdbnhvP3uou9TKqpyBlC37oDzhmzNjsRzT0E//abt96ENjZDX9wAmg9l3Vuj6ZWQlM4BCJNzZsQMxI4nHR95G7grGTc2b8Nm99+APd96Nj284go9vPIKd9Z3oC49jShM+PWYsikuhUexq2YDGxlacC4+JFCrFIMsWeyC9OievExk3pUALzLERsKnqU4WqbgYgqmp5Y5gToyKM0WZoc6vwZ9GSMHrfti2RbanZ4A3AIzvw2tQQWI5bxYPrr8cXD30UexrWgqb8iVQq49bWLXj0xt/Goaas02A4PINTF06ik7oQ6N5qDR1dIcTjs/gxJV5+DiyYzTrnuuO9wsWjyqg6AXAeuSWbt4czxB77oe16v9TeAXnNOvBYRKxXr6JkUN3eAAxuYiAykT3nacLvbbsDZF4KRIGDyvjs3nvEEmmK8zNXYE5OYB2TxZJvynBdEYyJt35ugIxpIvrYDzIGMvX54Th888rvUSKqSgBofQPUg4czx9rx12zP3kCbWyG1rQEPh6CfP1f1+v5cAqoH4/EwjJxl2fet2Q15gczQaVqddTgcyCYBH0+EoZsa/MFp8MgspJZ20Kbm5XcomRR+SHleIuaVy0iePJY5dlx/I6i/Yfn3KCFVJQDOW27P7PbyZBzx5+xd8qQNjak3f1TkzK/SUMnFcCsqIqbVZtjgLWzgbpxzXUzX4JFk6EMD4LEo5PY1oP76Bb49B87BI2HhJbqI41/y2V9kC4FIMpxH31VY+2WiagRAamkTiWpTJJ77pa1b6dTnh7xuI5BMwOjvXZWDP808RafAvfx5l6UbYgzG0ACgJSGvWbdwXYQ0mqh8U0jgEYtFkXj+l5ljddtuUBtsDruoGgFw3vjOjBHFZmegHX/NtraJqkLq3ghuGND7zlpSBObSfd+7cefPvoyjX/scPGuL0IlLSEzX4JGtWZ77oxMLXG2lP2K9zi2riBpCdeGGDn3gPLhpQFq7LhvbkAvn4NGIyLCxjBeIduwV4UUKAITAeVP1VOWtCgGQmltT+fkFiReesc/vhhDI3ZtAJAnmwPkFDV5vVwcOfe5T8G/egLabD+K6P/l39tw/DRUB59TjFSVU6xvEf/56ceyrA3V7xMDLU6AjzYQWQYvTZ9H5/3n4lMUmyMdoPISXJvozxy1OHxQiW9wiuK7DvDgAQiXIa9dbVnW4rgtdP758xzpuGEi8+GzmWN2yo2pmgaoQAMf1NyDj5hyahvbmcdvaljvWgni8MK5cWtRPvvP2G0Byam41X79nfnjicqAU1O0BbWyC1NEJuXOtMDQbA6J+sM8P6vGJa7x14ri+EVKgFXJbB6TWNiEgLrelFthgJAiZSNjgzRb1uRidxOdO/wx8AV0oYer49IkfIsmyL5XNPpECcSBqXZtn8RjMsSsgLjek1g5xMhYDD80U5RainXojJzcTgePQDStuy04WqfxWHqi3TpQlSqG9+qJt+jnx14O2tInQwfHRRa9tu/mQ5Vh2u+DuaEXs8uLfm3dPpxPE4xMDlxAAHFzTwGIh4aNvaIDJwJkJEqkHTcTAw7MiHpgSEFkVLscOJ6jbC7i9oJyDJeLgsQguRIKIGkkcbOpGXyQIlnrzf3PwVQxEJvG7PUexu2ENJEKQZAaeG+/DF879En2RbJYMn+zEDn87LsWmEMrjKm0Gx8VM1dAE88qwPXskponk6y/D9c47AQDqzt1IPvOLitcsq7gAqPsPZqZ8noxDe/PYEt8oEEmC3LUeXNdgXpzvLmC51KEicHD3vPP+zd0FCwB1eUD8/kyIJEvEgWgEbE6hCgucZ5JQ8dQ1WRUtJGYR1QG4PaBOF+BygxsaXo+M4Gh9N25s3ohnx89nmnsx2I8Xg/1wSQq8sgMzWhw6t75MJEJxW9s2UFC8FLyw4O8x+s6Bdm2A1LFW7JDb8FLSTr4O5423gqgOECpD3X8QCZtX+pZLZVUgQqHmZG/WTrxu26aU1NYJIiswh5cuHt18aA9kl2PeeX9P95L3IaoKqa0DNNAMQiWw0AyMK8NgwXGweKyg2OAFYQwsEQebCsIYG4EZDoFQCecUE/1Uw87Gtbi+aX4f46aOiWRk3uBXiITb27eh3eXHS5MX8rtFmyZ4KAQzNAPz0oCoRtnWsfLfkANPJqGdeD1zrO7at2Bly3JR0bsrG3tyltw4kifesKVd4nJBam4FD4cK8u9pu/lg3vOLCgAhwvW3tQNElsFmpmGMXF72CknBMBM8PAtjbBQsHMIz4Uu4LHMc6NiK967ZjQbVs+jX17ga8MG1+7HB04wT05dwYvrS/IsSqU2tlNMhm5kGn52B1NImgvBtIHnidaQXZGldPZT1G21pd6VUVAVS92TrcxsXB2xLvy2v7QY4h3FpsKDr248eynvet4AAEEUBbRIZIVg8Bj4zVb4dZc7AwrNIxmP4sZbAOwIbsbt5LT7ibsKl6CQuRqcQ0uNImjpcsoIm1Yv13gCaHT4kmYEnx87i3OwctS7lypBv9jWGL0LZugvy2i5bMkOzqSCM4SERdwFA2b0f+oXzS3yrdFRMAIjDATk3pcYpe3R/WlcP4vHBHLtcUJoQV3sz6hYY6P6edcKQzc3l43RCamoBCAGbmqyYEccNA2ZwAi/F4zjb0Ia93hZ0exqw1t0479pZI4Fj0xdxYnp4ftxAMilWxxZQ1XgyCXNiFFJrB6jPn13PLwLt5BtZAdi0GURVK+aPVTEBkDdvz7o9GBqM8/aU4pHa2gHTBBsrrP7tQuoPMH8liLo8oE0BcG6CjY+Ba5WPd2XRCKa0i3jaiIJSGY2RBNyMwUEVxE0dIT2OGS3PjnpqU6ug3dzxUUiBVkht7bYIgN57GvzO94NIMoisQtm0BVoJ3N0LoWI2gLp5e+azfmHhDarlQL0+8fafLDyAvf3m/OpPGv/mbtG2ywMaaAY3DbCx0aoY/Gm4roMFJ8AMHZNeJy4acZydHcXF6GT+wb8MVwYgPduMi7SPcypsrqi/ySSMC32ZY2XrzkWuLi0VEQAiyZBzjB/j7Nu2tCu1dYiVk/HCMkMTiaLliLWGGJ+jCvh7ukUmuKaAKA4xPrqgvt+0dxuu/1+fxq7f+20oHnuMxkLhhgFzcgLc0EEbGkWG53kXrcyVAQDYxCjAmJhhbUA7l/03l9dvEkmDK0BFVCCpqzsT6wvOoA/0Lf6FAiBOJ4jPDzYxVnDoZOPubXDU5zh+cY4rT76IzttvzJzyb90AqalFqD0TYwvuhqr1fhz9xv/ODHzP2ja8/G//68p/0EowTbCpIGigGVJDAGZwPOP3lK8U0nLgug42OQHa3AridBadgdvs7xW2FSEgigq5s0s45JWZiswAufkkjSvDK/IvmQttFK4B5mRhjmEA0H7Uqv/PnBvA2PNWY7xuyyZh8E6MLbrS037zActbv+vuW+Fd11lwX+yCG4bIwkAIaGOjMOJtcGUAkMnuQHNqh624rXjMUrNN2dizyNWloyICIHety3w2bHj7AwBtaAIS8WW5ULfdZBWA0edeQ6hv0HLOv74DLDS9pM7fuHe75ZhIFFt++8MF98VOuK4LNYdIIIzbFu7J4lEgEQdtXEHgTB70gezyp9y1YZErS0fZBYAoCqTmrB5pLOGmUAjUWweiOmAuI+ha9fvQuHur5dzo068i1Gvtj+Rywlm3tD7ftG/7vHPd990JR6O/4D7ZCQtOwJwYBUl7mNqEOTUJoqi2GMPG0GDms9TWlinBVE7KLgBSR1fWu5GbtpQupQ1Nwv9mGQlZW2+4DkTOGl5GPIng66eQDE5Dm7Yu9aVXghZCUhXUb98077zscqDnoXsL7pMtpFwZWDQCPjUpkuY2FK+ypGHTQsW0Qw0yLw9l9x+IZJvLxXKogABkf6Q5NmpLrh9S5xcFKZbR1tzlz4mXj8NMqTmzF6xuAkv5BNXv3AxJzZ/xYNOv3QvJWaY32xxXBm4YYLMhENWRSVRVLFzTwWNRkLriZzau6zAnsrvSUsfaottcLuUXgJas+mOOFP/2Jw4HiKpayvgUQuuN11mOR599NfN5dsi6ibaUADTt3bbg3xyNfnR/8M5l9W3ZMAY+GxLPYE7pUhGza4IUGutbyO0iQqiIo3jBNkZHMp+llvIHyZRfAJpbM5+NieX52ueDpJzpeLhwl4S6nm64O1st50aeFSGYxOXC7MURy98W8glK07hnYQEAgC2/eb8l2MZWFsnKAADgDGY4DKKoqYLYxcNnxbMmS8UOFwCbyL5sikrNskLKKwCSBKkxG8nExgtzV1gM6qsTDmLL8Mlpn+P+EB0eRTil9hC3F7OD1lQsGZ+gBQjs32E5vvjDn1uOfevXouM2myOgCszKACCTs4fYYLgCEM+as6WD5wvAzBEA2hQou3t0We9G6/yW8D47UuURjxc8Fl2W3/3c6K/RZ1LqD6WgLjdmzliXZtM+QflwNNXDs8b65jr9xW9i8oTVt2nrv/iVgvu3JMt0ZQAzwZLxeeGVK4Yx8FgMxFu8QOVmjiZUBvEVL1TLobwCkJMUiRsaWLEZmAkFUdRlbaRJThXNh/ZYzo0+J4I0qNMFEILkpcvQZqwrQfVbuvO2N/ftr4WjCPcP4fxXvme97rqdaJpz7UIE9m3D5gffD1/XnFWRIlwZEImKzbF0wuEi4Yl4qiJMcUOIRcIWvy2pvryJs8osAFlDjM3MoOCENgtAnA5RKXEZyV2bD+6xrMpww8T4i6lAHKcTAAdLJhDqHbR8r25Td972GvdY1/+nT50BZwxDjz09L5xyqVlAqfPg4Gf+NW790p9iz7/9Ndz2zc+hYZvYIComKwMAsGTqe3bZAcmEcGMo2hDmYKGZzFHBiblsorwCkDNl8vDyVm3yQVLVEdky/FLmuj9PnjgNLSx2SonTKYxJxjB7/qLluoX2AgL7rAZw8JhQfbhh4tyXrbNA5203CvcIQqBu2QHXrXfCecOtUDZuRvvNB/DuR/8C3XcfzVwvO1W8488+CUVC8a4MjIHrmm2GcPqZE0fxM0puiShaZhWorM5wJGctmsWL357P1A9IFv5WbJvj/5NZ/qQSiKSI7A3AvBnAl2cGIBJFwx7rbvLUydOZzxce/Ql2PPzrUP2+zPXr/ujTCDZuh9xpXfN2SgZivjBcsP4W75pWXPeZf4MXf/ePC/6NC8ETcVBfyg4rJlYZyDxz4nQBoeLSyrMc9xVi035FoZR1BiDu7I+zowJL2qO00FgCV3sz/D3rLedG08ufSupdoAt9dJ5PUJ6VIP+mdVa3Z84xeTwrAEYsjv5v/ShzfDHqw8yud88b/ACQMGWcmWnAUGS+Ybn2zpvR89B9S//ApUj9NjvSlKefuS0pz3N8lYjLHhulUMorADnTJU/YULpTkkT6bV6YLdF20wHLsTYdwtSbvaJvaWFKpQqc6xMku13wzNk7aJzj/xO5NILklNV4Pv+1H8DUdASTTlyaM7jN0SvzXEGGoj6cf2N4njvGnj/8XTTu2rzkb1wMngqHzLiiFwNLPfdFstgV3FTOWLAr+L5QyqsCydnbLZSfM01abVgMye8DcalAAdcCQMc7D1uOR59/IxsAkwrPTOvZyeA0tJkQ1Prslr9/czeiw1nDtmmOARw8Nj+wJz4WxNA//QKTt/565pwxNIDp//zJTFCIunUnGv7rX4hgfgCXeQtG/sMf46a//7PMBpqkKjj8hT/Bz9/7WxmbpVAkpwrJ4QBkGZLPA8YNcLmIrHcpZLcKznygoaWfvxZaeJ8mdyzk+meVg/IGxORG/Zj5dVB3Zytu/sqfz1NVSsFIjvtDWr3JjQgL9Q5alkzrNnXjylMvZ46b9lsN4KkT+eOa+35+HK6bf1MccI6p//RvoPf3Zv6unX0LU3/wMFq+/k8il+nabkxcmcXZv3sE2373VzPXebvaceB/fqpge8Db1YH9n3kYbTcdLPvAmkvo/ACe/finEbucZ/PTyDHupfIOyfLOADk/Lr32S+as+257+GNlGfzgHOMnz2fuT+obQDw+kEh9RqWaHRq1CIB/55bM9YrXPW9pdKp/eN7vAYCEpxFp5c8YvmgZ/Gn082dhDF/MzALy9l1468vfR/P1+xDYn51p1t55Mzb/ywdx/tGfLPjTCKXo+ZW7sEa2+OcAABlDSURBVPPhX4PszBMaWQH8Peux7eGP4dhnv2Q5z2emLfsAuVpCOaiK5LiVYObsBcQnFq+VO9s/ZDmu25A1Xhu3b7L495iahplzC8Q2kAL3O3KNbM7BDYaX/uAvkJy2Lhnv/uSvo2F7/oRS3rXtuOX//in2/v5vVc3gr2bKKm4WSU+nRJmTue3MX38Vzfu2lnQWSExM4Y3/8leWe3MOcJOJ9faUGjRzyqrS1K3vFH/nHI09ayx/m3nrPMyJ/OGYxum3Mp/lNeug9Gydl2RK2bwNcmdX5lg//Sb4zDRiM9N45d//N9z05T/P2gOKgsOf/Q8We4BQip6H7sGu3/+dvGkeK03o/ADO/PVX5/17A3M0gzKXrCrvfJObqkTKP/nELo/hp3d8vDAjeN0GEI8HxjJzyuiRKPhcGySl9hBKM3bAQitB0eFRNO21ujUEc5Y/56L1nhbqzRqxlNr4Z38tjOCzQjDU7bvQ8Cf/OzMDGJcGLQIy8syrOPO338L2f/Vg5lyuPeBd14nrP/epvAl+OWM4/7Uf4PTf/AM4CKTWDrDZGVs2IuUdu8EjEZgXF06ym2YxIxi59olddSEKpLwzQI6xs9RS3KIPLIUcCoNSpaBrlyT94CUJSL2FFlsJmhsCOXViYQEA55j9wv9C459/XvR7bTeav/p9mGMjACHz3IBnv/C5eUu7b/3lV9BycLdlkK+982Yc+ZvPoP3Ww3nf+pGLl/HKf/wfCL52CoDY6WbhKNhUCCy2cK2EgolpYDNhGEU+/9yxkDtGykFZbQCeyNnxs8MpyzSFM1YxhSxSpJfiiGz1bcnnE+RZ2wZHk9VnJXh88cx28ad/hvDff95yTmptnzf4w1/6K8SfsbpTi/6ZePHhP523z7D2PbfMG/ycMfR+5R/xs7t+IzP4AYCkyqTyuekRVwJNPXcbEgFTi4eAfXXhCrp3OW+W68hF3ItnMy6ovfSgtSHom6d2SaFYJ8V8PkGBfVb1JzExVVAdgdm//zymPv2v8ybtNS4NYupTn8Dsl/9mwe/HR4N45ZP/fV7yrlwiFy/jqQf+HY7/6edhxOfkRk3t2nK9eAFIP3M72kKu+0OZBaC8KlDOj7MjRjWzm+xwAQUkwl0UZoKbesbBLk0+nyBt1roRNbmY+jOH+NNPIP7Mz6H0bIWyfQ9AOPS3T0HvLSw3aj57AMjq+m9+7kvzB34K4nSKt3+xfkAAkHpOduzoU1euh8BVLAAsktUV7Qh8SLtBU6cTZvE2HXgiIdJ95DiL5fUJmqOfTy6h/sy/EYfeewZGqmxTvpWRxXjrL7+CwL4daDm8D8B8XT8vVMRO5P4bFEM6roAvwxFxIUhdjpv8MkJb7aC8ApDr993QAFEYb+UxATyRFKF+DntcfJFIAB4fqMOZ0UXzrQQ1zfEAXc4MYAfcMPHsxz+Frg+IotNDP3oSZmJxh0Ca9sNaRuzEYhCHU+xVJIvN6kHmxIkU51m6XMorADk/jkgKqNtdXNYynvJxt8mDkCXioJwDHm9GF03nCVIbctKA5JYPNRmmThZfOGK5mEkNA995vPAveD3Z2mU2QJwukX5lifKsS0G9Pss+QO5LshyU1QhmsyEgp24VzQmQXyk8EgFxe22LdWXxmJjec7wcZ/suLviVUO8AjJg9g6pkUAnU4Sq+ZlmmPQridotg+2KbasqOAc4MEeRfRsrrCsFMSxA0bS0+1TaLzIpYV5syHvBoWLSXE7021xDOZTKPB2i1Qbw+ETpqUzUb6vEBhC47F1M+cpeBWXCi6BlluZTdF8jISYWSmyNopfBUxRLis0kAEglwXQP1+TIB36HzgwteP3nSnso2JYNQSD4fuK4VndI802SdeNZ27CbTnDFgLlHLuRSUXQByf6RsQ7EFrmngWtKWHDWZNkMzQm1IrVQtKgALuEBXC8RXB1BJ/CaboF4/uJa0papP7hhYyJeqlJRfAK4MZz5LLe32bGLNhkQWZDvC8yB2I7mWBK2rA5HleStBadIpUKoVIsuQ6sRgtWuHlagKiNtjCWRfeVuqRQswr+Qp3Vpiyi8AI8NZQ4xSSG3FF5Fg01OpghDFG9XZNidF3qH6xrwZowFg+uSZRXdlKw1paAQIbCs/CwC0QdQGWE4m7oWQOruyeYVsyhS+XMouAFzXYY5nc2/KXd1Ft8kis+Ba0pJ2sVi4poGFZ0FdblCvL+9KUPBYedf/lwP11oE63WDhWVtLkEqNTeLZ2GBQy2uzhVLM0RFbMoUvl4oExOQWRsgtl1QMbDoIOF22pQEHICrD6BpofSNC/fOn59wUKNUEUVXQ+gZwXbN1XZ263IDTBTZlj65uKZVlQ6GUlVARAcitDC61d9qSCyY9JdMme8r3ABAbR8EJgHOER+ZP+dVoABNZFnp1Tt/tIv1s7cjpSl1uSK3Z1I/5wkTLQUUEwLx0MZsJgFAo6+dXV1kuPJEAD4dAm5ptLbXDDR3m5DhCF4Yt58ODw/NckyuOJIllRUJhTo4vmXljORBFAW1qBp+dAS/W8RCAtHFzNhGBloRxufwGMFAhAeCmAWOgP3OsbLOnULI5ekVkeLa50AJPJDDx9EuYSKc9NBlOf+Ebtt6jWIgsQ2ppA5EVsMkJ29b809DmNoBSmKMjS19cAGpOcWx9sM+WuIKVUJE6wYBIBaL0CKcyeUMPiMNR9JuFRcLg0TCkQKuo5m5jfKkZCeOZX/99NN14CIngFMKnqmcHOLOcSChYcNz2oBIiy5ACLeCRWVuMX+J0Qt6QUyj9zFuLXF1aKpYVwjh/JpupTJIh9yxeZaVQzJErYhOrpfhd5nltR8KYePoFxEYmIbW0W9wlKgX11qXKThGYwbGSRFTRljZAkmx7+yubt4PQVFIEQ4fed86WdldCxQSAaxqM/qwx7Ni935Z2WTgkZoHmdhCH/dkReCIBc2wE3NBBG5pAAy1lz2UDZI1d2tAo7JSxEdvVHkC8raWWNvH2D9tj86h7svXZ9L6z9kSVrZCK5gXSTr6R+Sx3rbd4BhaDcWkwk2GtFKQHXHqfQGrrBK2rL095H0pB6uohtXWCOF1g4VBGIEuBSNVCYFyyZ8ebNgYsyYG1k8dsaXelVFQA9At9lreKY/d1i1xdODwehzkxBuLzg5aq4gjnYDNTMMeuiL0Cfz3kjk4R3WRDwth5UAmkrh5y+xpI/npwXYM5dkXEWNi41Gm5ZX0jSF09zIlR20IVHfsOQgRCAWx2BsZg/+JfKDGVzQzHGbRT2TeAuveAbVXNzdHL4LoOaU23JeDCbrimidkgOA5umpD89ZA71oAGWkBdnuLiFCgFdXlAm1sgd6QGvmmABcfFW9/GHd65EFmGtGad2Lm3oZwtIEra5qo/2qljJRPeQqnYKlAa7Y1X4HjHTSCSDOJwQt1zAMnXXiy+YdOEcWkQyoYeyOs2QL9Q2o0WFo8B8RiI0wni8YldU5cbFEi5IscB3RCGv2GCMzMbWUYpCJUAWRTpgKKIdtL7GZwLB71ouCR6fj7krvUgiiI2qGxaolT3HgJRhV3GmQHt+Gu2tFsMFRcAFotCe/tUxgh2HDyM5LFXiisHlIKHpmGOj0JqaYPU0lYWf3OeSIAnEmCUisgypxPE6RSVWeaQrrbO87hyc1MXS46JhAhjLKPTndTaDuJvELPMrD2uFESS4ThwfeZYe/MkWNSG5FxFUnEBAIDkqy/AsXsfAAJaVw91135oJ+x5O5hXLoF6vJA61ooKi+V66IyJeOd0zDOlIIoisqBRSRyn0kPy2ZAY4MwEN3SxKlIhL1Pq9kBqXwMeiwrPXZtQ9h7IvgQ4R/LV521ruxiqIjs0C45D6806ljlvvMWeKiYAwDmMwT6hn2/osaGq4QphDDyZBItGwMIhsNA02Ezqv9C0OBeNiM3ACg1+oqqQNvSAMxPG4Hnb9HMiy3AevilzrJ17yxIaW0mqQgAAIPHsU5kHTr11UPcfWuIbhcM1DeZAH4gkQd60zbbAmasJIitQNm0FkRWYA/02pDvJoh44nI3Y4wyJ535pW9vFUjUCwILj0M5kszw7b7hFrKLY1X5kFsZAP4iiQt6wuTRLlasVSiFv6AEcThiD/bZteAEA9XjhPJIt/aqdPgU2Wf7Qx4WoGgEAgMQvn8gUqSMOJ5xH32Vr+yw0DePyEIjbA2XDppoQAACVoGzoAfF4YVwaBJtZvGjIcnHcckd25cfUEX/mSVvbL5aqEgAWDiH52kuZY3XPAUvRCFvuMTEGc+QyiM8PpWerfbbGKoTIingGPj/MkWGw4Lit7Usda+DYuTdznHzpOdtWleyiqgQAAJIvPZvNN0MIXHe93/Y3tTl6GcbwRRC3B/KW7SXxGap2iEOFsnkbiNsD8/KQ7fG4RJLhfs+9mb0ONjuD5Csv2HoPO6g6AeCahvgTP84cS4FWywqCXbCJMRgDfSCKArlnO6gN6dpXC9TjhdyzHVBVGAPnS7I/4jhyM6RANi4j/sSPKxLzuxRVJwAAoPeegdab9bd33nArpI41i3xjZbCZKRh9vQAlkDdvn1es4mpEam0XrueEwujrLUkyWqm9E84jN2eOtbNvVtTleTGqUgAAIPGzn2QdsCiF+30fss1PKBcWmYVx9i3wWBRSZ5cwCCvg3lxyJAny+h6xIRiPweh925bUhnMhqgr3Bz4MEKG2sngUiSces/0+diHJqvszle5EPriugU1NQt22C4AIoqa+uoILSSwL0xSB3lQCbWoW+YW0ZMn9bjJlokp8H1rfCHnjFlCPB+b4iPDALFE1Rvfd90HJuKFzxH70XZhj5c/3UyhVKwAAwCaDID4/5DaRPUBqaQeLRWGOXC7J/Xg4BBaLgfrrITU1g3o84LGILX5J+Si1ABCnE0r3RpF9gTGxxm/zSk8ujgOH4bz+xsyxduw1exwbS0hVCwAAmBf7oW7eKlKgA1DWb4I+2G9LYta8JBMinUgq05wUaBElXe1KLZ5DqQSAyDKktg7I6zaAqE6Y46MwBvoAm2oD5ENesw6eD3woExRkjo8g9sPvVMyto1CqXgDAGPSBPqi79gndnFAom7dB7z1tS32qvHAOHp4FC00Lf/yMIMhiENn0j2q3ABBFgdTWCbl7I6jPDx4Nwxg4L1IjltDvntY3wPPAx7IbXsk4Io98FbyY4idlovoFAKIQGwuOC3uAELF0ub4H+ulTJdNlAQCGATYVBI9GhEtzYxOkQKvwJdL1osMQ7RIAEZYp3vjUVwcejcAcGhSqYokrrxOXG96P/iakuqynZ+wHj9rqSVpKVoUAACLzG9e1TBIt6nZDXrsO+pk3Sz7Nci0pBCE8C+JwZILhpYZGUVhbTwJzK88XQDECQFQFUqAVStd60LZOEI8XPByCeXEA5ugVcK345FVL90GF91cesiwfx5/6KbS3TpT83nZBHJ5AZWPSlon79ruhXveOzLFx8QKi3/0HW3MALUV6NqANgey0H4uCRULgs2ERyFKAUJJUvHJBVSIpBfX4QOp8oF5/ps5yWjjZ9GTZosUAAJIEz4d+Fcr6bH5P7cRriP30R+Xrgw2sOgEAofDc9wCUnDxCen8vYj94pKxCkIZ6fKCNTSB1/owwgHPwWBQ8EQdPJsASCSAZFy7GOSWA8goApWK/w+ECdTpBHE4Qp0sM+JxUgnw2BDY1aUuiquVCZBnuez8CZePmzDnt3NvC6C1ziaNiWX0CAIi3z30ftfwDGJcGxUxQwkDxpSCqCuKrA/XWgXh9IqY3p6IkACEczARME9QjVrZYNAJIkogLzne9roFHwiINvM3pzpcLURR4PvhRyN3ZfK7GYB+i3/0muFn+F1CxrE4BAEAUFZ77H4TctT5zzrg8hOj3vgEer5KqjYSI4HaHE8ThEsYzlQCJgkgSiD81A4SmwU1T2BHMBNd18KSYPXgiUfHMCWmIyw3v/Q9C6sjm9TGGBhD9zj+ULC9RqVm1AgAIIXDf+4Alz7w5PYXod79uSwWTUrMsG6DC0PoGeO5/CFJO8jL9Qi9i33901Q5+YBWtAuWFmTDOvg2puRVSKnc9dbmgbNsFc3jI1simUlAuV4hikdesg+cjH88udSKt838bWIVqTy6rWwAAgDPoZ98GdbkyHqNEUaHu2gdumjCHq7iI3SoQAHXvAXju+ZWsgQ8geeJ1xB/7QdXv8hbC6hcAAACHfuE8uK5D6d4oDElCoHRvBG1oFM5fJfLnKYZqFgCiqnDffR+ch4/mFLJjiD/5OBLP/qJq7JJiWdU2QD6UTVuE67TDmTlnTk8Kr8QSOdGtlGq1AaTONXC/735I9Y2ZczwZR+xH36tYKaNScdUJAADQhkZ4PvhRSIGcGgHcROKFZ5B46dmqmQ2qTgAkCc4jR8VbPyenqTk+guj3HylJ8EyluSoFABB2gPNdd8Gx94DlPAuOIfrYDy0FuytFNQmA3NkF110fsIQxAoB2/FXEn/zpql7pWYyrVgDSKJu3wXXXPdbyqZwjefINJJ/9hUhfWCGqQQCoxwvH0dvh2LXPsgnH4jHEH/sB9PNnK9a3cnDVCwCQSs50x91Qt1iL8XEticQLT0N74+WKuFFUUgCIrEA9cD2cR26xrPAAIoY38cRjYLHKJ68tNdeEAKRRerbCdcd752VqZpFZJF58RlSsKaN9UAkBIJIMZe8BOA/flE1XmILNziD+xI+rNoC9FFxTAgAIXxbH4ZvhuP4GkYs/BzY7g+TrL0M78VpZ/G3KKQDE4YC69yAcB94x7wXADQ3JV15A8uXnqzJ1SSm55gQgDamrh+uW26Bu2z3PAY1rSWjHX0Py5Bu2VEVfsA9lEADa1AzH3gNQ91w3T9UBZ9BOn0Li6V9U/a55qSAOTyAKwL3klVcpNNAC503vhLplO9K1q7JwGMNDSJ58A0bvaVsqpOdSKgEgTieUnm1Q9y6QWpJzaOfeQuK5p6omTXmFiBOHJ3AFQHule1JpaKAFjkNHoO7ck6lhmwtnBoz+Pmjn3obZ32tLPV47BYC6PJA2bYa6ZQfkDRvz/wbTgPbWCSRffeFaH/hpxonDEzgNwJ4q1VcB1OOFuu8g1N37RenTfHAOc/QK9Au9MC5dhHnl0opshmIEgKgqpI4uyF3roGzoEalP5sYSpGCzM9BOHYN27LVrYmWnYDj6icMT+BGA91W6L1UHIVDW90DZsw/Kxs0g8iJZ6RiDOTEKY3REZJ+eGAObDIJFwgCKNbEIqNcH2hQQhbGbWyG3d0Bqbl20LjE3dOjnz0I/dRz6YN9V47tjJwR4jTi9Tf+dc/IHle5MNUNUFcqmLVC27oS8flO2euMScNMAm5kBD88IlSkWA0vERQ0wzsGTwgmOOJyZbBfU6QLcblC3J1XnuD6vOpP3floS+mAfjDNvQ+87d82t6CwXAnyLqN7AA4TjkUp3ZtUgSZA7u6Bs7IHctR5SW3smD2bZ4SbMkREYQwPQL5yHMTxkW0nTawHO8V+I2x3oMAmGMX8JpEYBEEWF1NYBqXONCMxpbhX+NHZXn2EmzOA4zIkxmOPjMK9cgjly+ar10SkHnJAHCAA4PIGTAHZXuD9XD4SC+Oog1TeA+utBfXUgLjeIywXi8oBIqTKpqYqVPKmJKpKmCR6Pgsfj4PEYWHgWLDQDc2ZapIJcZRkXqh1iyuvTyuVPURMA++AMfHYGRpWVA6qRA8GFRGJ0kAIAB/1mpftTo0aZeRJIFcjQouOnCPBGZftTo0b54CZ/HMipEMMJ/3+V606NGuWDANNavOExIEcAkhH56wBKVz2hRo0qgRN8G+hLApYaYWNRDv6XlepUjRrlgpr8q+nP1rX/QMCnxskAAW8qd6dq1CgTTyejwVvTB9bdmlhMkx2uGEDeU/Zu1ahRBgj4bxl6fCB7PB/J4Qm8CmB/+bpVo0YZ4HghGQvemHsqnzuhSRn7BIDatmONqwmTAQ/PPZnXYcUw4sOK6nEDuDHf32vUWHVw8kUtFvzy3NOLOcApTk/geQ4cKmG3atQoB8NJxdiFmZl5vikLR1QAOpfpRwHUHFpqrGYMSukD+QY/sLgAIBka7ycE9wCoRVbUWJVw8D+Kh8dfWOjvSzqtG1rsoqJ4RkDwfnu7VqNGaSHAt5PRyU8udk1BURuGHjsuKW5GCG5d+uoaNaqCJ5PR4IcALBoiV3DYkqnHnpUUj0EI3ll012rUKCEEeD3pYHcjvnTummXF7Zl67DlJdSUIyLtQC6GsUZ08mXThPZicLKiA8rIDV009/oLkcJ8jwN0AlCW/UKNGmRA6f/BDiMUKrpO76CrQQmiR4KMM5AiA6q1AV+NawiAEf5KIBj+KZa5YFqXGeL1tzTrMvwPn9xbTTo0aRTBMKflIPDzx/Eq+bIser3qb76ec/x0HGuxor0aNAmAc+KaDJv99OBxecVV0W5LXmFrstKq4v84p6gDsxQpVqxo1CoLjBQbcp8eCX9Q0rWB9Px+2r+So3oadhEufBfAe1AShhr08TcD/WyI6+aRdDZZsKdPhC2wG458AyMcA1C11fY0a+SDANCf4DjX5V+LxyVdK0H6JaW72qnHcBc7fT4H3cKBx6S/VuKYhuADgKW7yx0T2hj57K5NYblVeZMUd2CuB7OFge0DILgDNAOpT/3nK3J8alSEOIAKCMOeYoMAFxnEWlJyjhvRKIjE6WK6O/H9jFn/qqyjGRAAAAABJRU5ErkJggg==";
const PNG_512 = "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";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================

// ============================================================
//  Embedded UI (single-file deployment) — served at "/"
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OUR HOME · Finance Ops</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="var(--bg)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="MAM">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script crossorigin src="https://unpkg.com/prop-types@15.8.1/prop-types.min.js"></script>
<script crossorigin src="https://unpkg.com/recharts@2.12.7/umd/Recharts.js"></script>
<script crossorigin src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
<style>
:root{--bg:#070b14;--bg-2:#0a1020;--bg-3:#0b1120;--surface:#0f1726;--surface-2:#0d1424;--surface-3:#0c1322;--border:#1c2740;--border-2:#2d3c5e;--border-soft:#16203580;--border-3:#14202f;--border-4:#3f4d68;--text:#e6edf7;--text-2:#cbd5e1;--text-dim:#7c8aa5;--text-faint:#5a6b86;--text-muted:#64748b;--text-soft:#94a3b8;--text-bright:#b8c4d8;--text-hi:#e8f0fc;--cyan:#22d3ee;--cyan-bright:#67e8f9;--teal:#5eead4;--teal-2:#5dd39e;--green:#34d399;--purple:#a78bfa;--purple-light:#c4b5fd;--purple-deep:#7c3aed;--pink:#f472b6;--pink-light:#f9a8d4;--red:#fb7185;--red-2:#ff5470;--amber:#fcd34d;--amber-2:#fbbf24;--orange:#ff9554;--on-accent:#04111a;--glow-cyan:#22d3ee55;--glow-cyan-2:#22d3ee44;--glow-cyan-3:#22d3ee22;--glow-cyan-4:#22d3ee66;--glow-cyan-5:#22d3ee88;--glow-purple:#a78bfa55;--glow-purple-2:#a78bfa44;--glow-purple-3:#a78bfa66;--glow-purple-4:#a78bfa22;--glow-purple-5:#a78bfa88;--glow-green:#34d39955;--glow-green-2:#34d39944;--glow-green-3:#34d39933;--glow-green-4:#34d39988;--glow-red:#fb718555;--glow-red-2:#fb718544;--glow-red-3:#fb718588;--glow-pink:#f472b655;--grid:#ffffff10;--logo-bg:linear-gradient(160deg,#0b111d,#070b14);--takehome-label:#a7f3d0;--pt-paid-bg:rgba(110,231,183,0.06);--pt-paid-border:rgba(110,231,183,0.16);--tt-bg:#0a1120ee;--tt-border:#243352;--tt-shadow:#000000aa;--dsurf-0:#0a102055;--dsurf-1:#0b111dcc;--dsurf-2:#0b111df0;--dsurf-3:#0b111df5;--dsurf-4:#0b111df8;--dsurf-5:#0f1726cc;--dsurf-6:#0f1726f0;--dsurf-7:#0f1726f5;--dsurf-8:#0f1726f8;--dsurf-9:rgba(11,17,29,0.5);--dsurf-10:rgba(11,17,29,0.85);--dsurf-11:rgba(11,17,29,0.95);--dsurf-12:rgba(11,17,29,0.97);--dsurf-13:rgba(11,17,29,0.98);--dsurf-14:rgba(15,23,38,0.4);--dsurf-15:rgba(15,23,38,0.5);--dsurf-16:rgba(15,23,38,0.6);--dsurf-17:rgba(15,23,38,0.85);--dsurf-18:rgba(15,23,38,0.95);--dsurf-19:rgba(15,23,38,0.97);--dsurf-20:rgba(15,23,38,0.98);--dsurf-21:rgba(7,11,20,.82);--dsurf-22:rgba(7,11,20,.85);--dsurf-23:rgba(7,11,20,0.5);--dsurf-24:rgba(7,11,20,0.6);--dsurf-25:rgba(7,11,20,0.75);}
[data-theme="light"]{--bg:#f3ede1;--bg-2:#f7f1e4;--bg-3:#fdfaf3;--surface:#fdfaf3;--surface-2:#f8f2e6;--surface-3:#f5eedf;--border:#e3d8c4;--border-2:#d8cbb2;--border-soft:#e8ddcaaa;--border-3:#ece2cf;--border-4:#d0c3a8;--text:#2b2417;--text-2:#4a4231;--text-dim:#7a6f57;--text-faint:#9a8f76;--text-muted:#857a60;--text-soft:#6e6450;--text-bright:#3a3322;--text-hi:#241e12;--cyan:#0e7c8e;--cyan-bright:#0b6878;--teal:#0f766e;--teal-2:#0f766e;--green:#0f7a52;--purple:#6d28d9;--purple-light:#7c3aed;--purple-deep:#5b21b6;--pink:#c0306f;--pink-light:#be2a66;--red:#c43a2b;--red-2:#b91c1c;--amber:#b5560a;--amber-2:#b5560a;--orange:#c2410c;--on-accent:#fdfaf3;--glow-cyan:#0e7c8e1f;--glow-cyan-2:#0e7c8e17;--glow-cyan-3:#0e7c8e0f;--glow-cyan-4:#0e7c8e24;--glow-cyan-5:#0e7c8e2e;--glow-purple:#6d28d91f;--glow-purple-2:#6d28d917;--glow-purple-3:#6d28d924;--glow-purple-4:#6d28d90f;--glow-purple-5:#6d28d92e;--glow-green:#0f7a521f;--glow-green-2:#0f7a5217;--glow-green-3:#0f7a520f;--glow-green-4:#0f7a522e;--glow-red:#c43a2b1f;--glow-red-2:#c43a2b17;--glow-red-3:#c43a2b2e;--glow-pink:#c0306f1f;--grid:#5c4a2e14;--logo-bg:linear-gradient(160deg,#fdfaf3,#efe6d4);--takehome-label:#0f766e;--pt-paid-bg:rgba(15,122,82,0.07);--pt-paid-border:rgba(15,122,82,0.18);--tt-bg:#fdfaf3f5;--tt-border:#e3d8c4;--tt-shadow:#5c4a2e55;--dsurf-0:rgba(247,241,228,0.333);--dsurf-1:rgba(253,250,243,0.8);--dsurf-2:rgba(253,250,243,0.941);--dsurf-3:rgba(253,250,243,0.961);--dsurf-4:rgba(253,250,243,0.973);--dsurf-5:rgba(253,250,243,0.8);--dsurf-6:rgba(253,250,243,0.941);--dsurf-7:rgba(253,250,243,0.961);--dsurf-8:rgba(253,250,243,0.973);--dsurf-9:rgba(247,241,228,0.5);--dsurf-10:rgba(253,250,243,0.85);--dsurf-11:rgba(253,250,243,0.95);--dsurf-12:rgba(253,250,243,0.97);--dsurf-13:rgba(253,250,243,0.98);--dsurf-14:rgba(247,241,228,0.4);--dsurf-15:rgba(247,241,228,0.5);--dsurf-16:rgba(247,241,228,0.6);--dsurf-17:rgba(253,250,243,0.85);--dsurf-18:rgba(253,250,243,0.95);--dsurf-19:rgba(253,250,243,0.97);--dsurf-20:rgba(253,250,243,0.98);--dsurf-21:rgba(253,250,243,0.82);--dsurf-22:rgba(253,250,243,0.85);--dsurf-23:rgba(247,241,228,0.5);--dsurf-24:rgba(247,241,228,0.6);--dsurf-25:rgba(247,241,228,0.75);}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:'Outfit',sans-serif;min-height:100vh}
.boot{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;color:var(--cyan);gap:14px;font-family:'JetBrains Mono'}
.boot-spinner{width:34px;height:34px;border:3px solid var(--border);border-top-color:var(--cyan);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.fp-root{position:relative;min-height:100vh;padding-bottom:50px}
.fp-grid-bg{position:fixed;inset:0;background-image:linear-gradient(#ffffff07 1px,transparent 1px),linear-gradient(90deg,#ffffff07 1px,transparent 1px);background-size:46px 46px;mask-image:radial-gradient(circle at 50% 0%,#000 0%,transparent 75%);pointer-events:none;z-index:0}
.fp-glow{position:fixed;border-radius:50%;filter:blur(120px);opacity:.5;pointer-events:none;z-index:0}
.fp-glow-1{width:520px;height:520px;background:#0e7490;top:-180px;left:-120px}
.fp-glow-2{width:480px;height:480px;background:#6d28d9;top:-120px;right:-140px;opacity:.35}
.fp-root>*:not(.fp-grid-bg):not(.fp-glow){position:relative;z-index:1}
.card{background:linear-gradient(160deg,var(--dsurf-5),var(--dsurf-1));border:1px solid var(--border);border-radius:16px;backdrop-filter:blur(12px);box-shadow:0 1px 0 #ffffff08 inset,0 24px 60px -30px #000}
.fp-top{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid #131d31;flex-wrap:wrap;gap:12px}
.fp-brand{display:flex;gap:14px;align-items:center}
.fp-logo-wrap{position:relative;width:68px;height:68px;flex-shrink:0}
.fp-logo-halo{position:absolute;inset:-6px;border-radius:24%;background:radial-gradient(circle at center,var(--glow-cyan) 0%,transparent 70%);filter:blur(10px);animation:fp-halo-breath 3.5s ease-in-out infinite;pointer-events:none;z-index:0}
.fp-logo{position:relative;width:100%;height:100%;display:grid;place-items:center;border-radius:14px;background:var(--logo-bg);border:1px solid var(--glow-cyan-4);overflow:hidden;box-shadow:0 0 22px var(--glow-cyan),0 0 40px var(--glow-cyan-3);z-index:1}
.fp-logo-svg{width:100%;height:100%;display:block}
.fp-brand-text{display:flex;flex-direction:column;justify-content:center;gap:3px}
.fp-logo-hb{filter:drop-shadow(0 0 3px #5eead488)}
@keyframes fp-halo-breath{0%,100%{opacity:0.45;transform:scale(1)}50%{opacity:0.8;transform:scale(1.08)}}
.fp-title{font-family:'Chakra Petch';font-weight:700;font-size:19px;letter-spacing:1px}
.fp-title span{color:var(--cyan);font-weight:600;font-size:13px}
.fp-sub{font-size:11px;color:var(--text-muted);letter-spacing:.5px}
.fp-top-right{display:flex;align-items:center;gap:18px}
.fp-tr-row{display:flex;align-items:center;gap:18px}
.fp-access{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text-soft);background:var(--surface-3);border:1px solid var(--border);padding:7px 12px;border-radius:30px}
.fp-access em{color:var(--cyan);font-style:normal;font-family:'JetBrains Mono';font-size:11px}
.fp-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
@keyframes pulse{50%{opacity:.4}}
.fp-clock{font-family:'JetBrains Mono';font-size:13px;color:var(--text-muted);letter-spacing:1px}

/* Date + Time block (replaces Cloudflare Access badge) */
.fp-datetime{display:inline-flex;align-items:center;gap:9px;font-family:'JetBrains Mono';font-size:12px;color:var(--text-soft);background:var(--surface-3);border:1px solid var(--border);padding:7px 14px;border-radius:30px;letter-spacing:.4px}
.fp-datetime svg{color:var(--cyan);flex-shrink:0}
.fp-datetime .fp-date{color:var(--text-2)}
.fp-datetime .fp-dt-sep{color:var(--border-4)}
.fp-datetime .fp-time{color:var(--cyan);letter-spacing:.8px}
.fp-control{display:flex;justify-content:space-between;align-items:center;padding:18px 28px 6px;flex-wrap:wrap;gap:12px}
@media(min-width:721px){
  .fp-sticky-top{position:sticky!important;top:0;z-index:50!important;background:var(--bg);border-bottom:1px solid var(--border);box-shadow:0 4px 16px -8px #000}
  .fp-sticky-top .fp-top{border-bottom:none}
}
.fp-nav{display:flex;gap:6px;background:var(--bg-3);border:1px solid var(--border);padding:5px;border-radius:12px}
.fp-nav button{display:flex;align-items:center;gap:7px;background:none;border:none;color:var(--text-dim);font-family:'Outfit';font-size:13.5px;font-weight:500;padding:9px 16px;border-radius:9px;cursor:pointer;transition:.18s}
.fp-nav button.on{background:linear-gradient(135deg,#0e7490,#155e75);color:#e6f9ff;box-shadow:0 0 20px #0891b255}
.fp-nav button:not(.on):hover{color:var(--text-2)}
/* === Liquid Glass effects (#1 specular + #3 edge glow + #4 adaptive tint) === */
/* Use :where() so existing card styles always win (0 specificity from :where) */
:where(.lg-fx,.card,.ln-bal-block,.ln-recon,.ln-np,.fp-loans-card,.fp-loans-mini,.fp-insight-card,.ln-hero,.ln-stat){--mx:-200px;--my:-200px;--proximity:0;--lg-tint-r:103;--lg-tint-g:232;--lg-tint-b:249;position:relative}
/* Combined tint (top-left) + specular (cursor) — single ::after, no ::before conflict */
:where(.lg-fx,.card,.ln-bal-block,.ln-recon,.ln-np,.fp-loans-card,.fp-loans-mini,.fp-insight-card,.ln-hero,.ln-stat)::after{content:'';position:absolute;inset:0;pointer-events:none;border-radius:inherit;z-index:2;background:radial-gradient(ellipse 60% 50% at top left,rgba(var(--lg-tint-r),var(--lg-tint-g),var(--lg-tint-b),0.07),transparent 60%);mix-blend-mode:screen}
/* Nav tabs keep the cursor specular (small buttons, looks right at that scale) */
.fp-nav button.lg-fx::after{background:radial-gradient(circle 70px at var(--mx) var(--my),rgba(255,255,255,0.14),rgba(255,255,255,0.04) 35%,transparent 60%),radial-gradient(ellipse 60% 50% at top left,rgba(var(--lg-tint-r),var(--lg-tint-g),var(--lg-tint-b),0.10),transparent 60%)}
/* Proximity edge glow via filter (additive, doesn't override box-shadow) */
:where(.card,.ln-bal-block,.ln-recon,.ln-np,.fp-loans-card,.fp-loans-mini,.fp-insight-card,.ln-hero,.ln-stat){filter:drop-shadow(0 0 calc(var(--proximity) * 14px) rgba(var(--lg-tint-r),var(--lg-tint-g),var(--lg-tint-b),calc(var(--proximity) * 0.22)));transition:filter 0.2s}
/* Nav tabs keep their dedicated box-shadow proximity (tighter visual) */
.fp-nav button.lg-fx > *{position:relative;z-index:3}
.fp-nav button.lg-fx > svg{position:relative;z-index:3}
.fp-nav button.lg-fx{overflow:hidden}
/* Per-tab tints */
.fp-nav button[data-tab="dashboard"]{--lg-tint-r:103;--lg-tint-g:232;--lg-tint-b:249}
.fp-nav button[data-tab="ledger"]{--lg-tint-r:167;--lg-tint-g:139;--lg-tint-b:250}
.fp-nav button[data-tab="installments"]{--lg-tint-r:249;--lg-tint-g:168;--lg-tint-b:212}
.fp-nav button[data-tab="savings"]{--lg-tint-r:93;--lg-tint-g:211;--lg-tint-b:158}
.fp-nav button[data-tab="car"]{--lg-tint-r:252;--lg-tint-g:211;--lg-tint-b:77}
.fp-nav button[data-tab="house"]{--lg-tint-r:94;--lg-tint-g:234;--lg-tint-b:212}
/* Section-aware tints — cards within these contexts pick up the loan's accent */
.ln-card-car :where(.card,.ln-bal-block,.ln-recon,.ln-np,.ln-hero,.ln-stat),.ln-car :where(.card,.ln-bal-block,.ln-recon,.ln-np,.ln-hero,.ln-stat){--lg-tint-r:252;--lg-tint-g:211;--lg-tint-b:77}
.ln-card-house :where(.card,.ln-bal-block,.ln-recon,.ln-np,.ln-hero,.ln-stat),.ln-house :where(.card,.ln-bal-block,.ln-recon,.ln-np,.ln-hero,.ln-stat){--lg-tint-r:94;--lg-tint-g:234;--lg-tint-b:212}
/* Outstanding cards get pink tint; Paid cards get teal */
.ln-bal-block:not(.right){--lg-tint-r:251;--lg-tint-g:113;--lg-tint-b:133}
.ln-bal-block.right{--lg-tint-r:94;--lg-tint-g:234;--lg-tint-b:212}
/* Edge glow proximity on nav tabs (override default transition shorthand) */
.fp-nav button.lg-fx{transition:color 0.18s,background 0.18s}
.fp-nav button.lg-fx:not(.on){box-shadow:0 0 calc(var(--proximity) * 16px) calc(var(--proximity) * 1.5px) rgba(var(--lg-tint-r),var(--lg-tint-g),var(--lg-tint-b),calc(var(--proximity) * 0.28))}
.fp-nav button.lg-fx.on{box-shadow:0 0 20px #0891b255,0 0 calc(var(--proximity) * 18px) calc(var(--proximity) * 2px) rgba(var(--lg-tint-r),var(--lg-tint-g),var(--lg-tint-b),calc(var(--proximity) * 0.32))}
.fp-tab-short{display:none}
.fp-tab-long{display:inline}
.fp-years{display:flex;gap:5px;flex-wrap:wrap}
.fp-years button{font-family:'JetBrains Mono';font-size:12px;color:var(--text-muted);background:var(--bg-3);border:1px solid var(--border);padding:8px 13px;border-radius:9px;cursor:pointer;transition:.18s}
.fp-years button.on{color:var(--bg);background:var(--cyan);border-color:var(--cyan);font-weight:700;box-shadow:0 0 18px var(--glow-cyan-4)}
.fp-years button:not(.on):hover{border-color:var(--border-2);color:var(--text-soft)}

/* ===== Mobile segmented year pill (hidden by default, shown at ≤720px) ===== */
.fp-years-mobile{display:none;position:relative;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:3px;width:100%}
.fp-years-mobile-pill{position:absolute;top:3px;bottom:3px;left:3px;background:linear-gradient(135deg,var(--cyan),#06b6d4);border-radius:8px;box-shadow:0 0 14px var(--glow-cyan-4);transition:transform 280ms cubic-bezier(0.22,0.9,0.4,1),width 280ms cubic-bezier(0.22,0.9,0.4,1);pointer-events:none;z-index:0}
.fp-years-mobile button{flex:1;background:transparent;border:none;padding:7px 0;color:var(--text-dim);font-family:'JetBrains Mono';font-size:11.5px;font-weight:700;cursor:pointer;position:relative;z-index:1;transition:color 200ms;letter-spacing:0.3px}
.fp-years-mobile button.on{color:var(--bg)}
.fp-main{padding:18px 28px}
.fp-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.fp-kpi{padding:20px}
.fp-kpi-top{display:flex;justify-content:space-between;align-items:center}
.fp-kpi-label{font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px}
.fp-kpi-ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center}
.fp-kpi-ic.pos{color:var(--green);background:#34d39915}
.fp-kpi-ic.neg{color:var(--pink);background:#f472b615}
.fp-kpi-ic.warn{color:var(--amber-2);background:#fbbf2415}
.fp-kpi-ic.accent{color:var(--cyan);background:#22d3ee15}
.fp-kpi-val{font-family:'JetBrains Mono';font-weight:700;font-size:26px;margin-top:14px;letter-spacing:-.5px;white-space:nowrap}
.fp-kpi-val .fp-kpi-rm{font-style:normal;font-size:17px;font-weight:600;opacity:.7;margin-right:5px;letter-spacing:0}
.fp-kpi-val.pos{color:var(--teal)}
.fp-kpi-val.neg{color:var(--pink-light)}
.fp-kpi-val.warn{color:var(--amber)}
.fp-kpi-val.accent{color:var(--cyan-bright)}
.fp-kpi-sub{font-size:11.5px;color:var(--text-muted);margin-top:6px}
.fp-charts{display:grid;grid-template-columns:1.7fr 1fr;gap:16px;margin-top:16px}

/* Dashboard row 2: side-by-side spend + yoy */
.fp-dashboard-row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}

/* Insights strip — 4 cards horizontally */
.fp-insights{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin-top:14px}
.fp-insight-card{background:linear-gradient(160deg,var(--dsurf-5),var(--dsurf-1));border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;gap:11px;align-items:flex-start;transition:.15s;backdrop-filter:blur(8px)}
.fp-insight-card:hover{border-color:var(--border-2);transform:translateY(-1px)}
.fp-insight-icon{width:30px;height:30px;border-radius:7px;display:grid;place-items:center;border:1px solid;flex-shrink:0}
.fp-insight-body{flex:1;min-width:0}
.fp-insight-label{font-family:'JetBrains Mono';font-size:9px;color:var(--text-faint);letter-spacing:1.2px;font-weight:500;margin-bottom:3px;text-transform:uppercase}
.fp-insight-value{font-family:'Chakra Petch';font-size:14px;font-weight:600;color:var(--text);line-height:1.2;margin-bottom:3px;word-wrap:break-word;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.fp-insight-sub{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);line-height:1.4}

/* YoY change list */
.fp-yoy-list{padding:6px 18px 14px;display:flex;flex-direction:column;gap:8px}
.fp-yoy-row{display:grid;grid-template-columns:140px 1fr 70px;gap:11px;align-items:center;padding:6px 0;border-bottom:1px dashed #ffffff06}
.fp-yoy-row:last-of-type{border-bottom:none}
.fp-yoy-cat{font-family:'Outfit';font-size:12px;color:var(--text-2);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-yoy-bar-wrap{height:7px;background:var(--bg-2);border-radius:4px;overflow:hidden;border:1px solid #1c274033}
.fp-yoy-bar{height:100%;border-radius:3px;transition:width .6s ease-out}
.fp-yoy-bar.up{background:linear-gradient(90deg,var(--amber-2),var(--pink-light));box-shadow:0 0 8px #f9a8d455}
.fp-yoy-bar.down{background:linear-gradient(90deg,var(--teal),var(--green));box-shadow:0 0 8px #5eead455}
.fp-yoy-pct{font-family:'JetBrains Mono';font-size:11px;font-weight:700;display:flex;align-items:center;gap:3px;justify-content:flex-end}
.fp-yoy-pct.up{color:var(--pink-light)}
.fp-yoy-pct.down{color:var(--teal)}

/* Installment burden forecast chart */
.fp-burden{margin-top:16px;padding:0}
.fp-burden-hint{padding:0 18px 14px;font-size:11px;color:var(--text-dim);line-height:1.4}
.fp-card-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px 4px}
.fp-card-head h3{margin:0;font-family:'Chakra Petch';font-size:15px;font-weight:600;letter-spacing:.5px}
.fp-tag{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-muted);background:var(--surface-3);padding:3px 9px;border-radius:20px;border:1px solid var(--border)}
.fp-chart-main,.fp-chart-side{padding-bottom:12px}
.fp-legend{display:flex;gap:18px;padding:0 18px 6px;font-size:12px;color:var(--text-soft)}
.fp-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.fp-cat{margin-top:16px;padding-bottom:10px}
.fp-cat-list{padding:6px 18px 14px;display:flex;flex-direction:column;gap:11px}
.fp-cat-row{display:grid;grid-template-columns:30px 1.4fr 3fr 52px 110px;align-items:center;gap:12px}
.fp-cat-ic{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#ffffff08}
.fp-cat-name{font-size:13.5px;color:var(--text-2)}
.fp-cat-bar{height:8px;background:var(--surface-3);border-radius:6px;overflow:hidden}
.fp-cat-fill{height:100%;border-radius:6px;transition:width .9s cubic-bezier(.2,.8,.2,1)}
.fp-cat-pct{font-family:'JetBrains Mono';font-size:12px;color:var(--text-muted);text-align:right}
.fp-cat-amt{font-family:'JetBrains Mono';font-size:13px;color:var(--text);text-align:right;font-weight:500}
.fp-tt{background:var(--tt-bg);border:1px solid var(--tt-border);border-radius:10px;padding:10px 12px;backdrop-filter:blur(8px);box-shadow:0 8px 24px -8px var(--tt-shadow)}
.fp-tt-label{font-family:'Chakra Petch';font-size:12px;color:var(--text-soft);margin-bottom:6px}
.fp-tt-row{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text-2);text-transform:capitalize}
.fp-tt-row i{width:8px;height:8px;border-radius:2px}
.fp-tt-row b{font-family:'JetBrains Mono';margin-left:auto;color:var(--text)}
.fp-entry-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;gap:18px;flex-wrap:wrap}
.fp-pick-label{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px}
.fp-months{display:flex;gap:4px;flex-wrap:wrap}
.fp-months button{font-family:'JetBrains Mono';font-size:11.5px;color:var(--text-dim);background:var(--bg-3);border:1px solid var(--border);width:42px;padding:7px 0;border-radius:8px;cursor:pointer;transition:.15s}
.fp-months button.on{background:linear-gradient(135deg,var(--purple-deep),var(--purple));color:#fff;border-color:var(--purple);box-shadow:0 0 14px var(--glow-purple)}
.fp-months button:not(.on):hover{border-color:var(--border-2)}
.fp-entry-totals{display:flex;gap:22px}
.fp-entry-totals div{text-align:right}
.fp-entry-totals span{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;display:block}
.fp-entry-totals b{font-family:'JetBrains Mono';font-size:18px;font-weight:700;white-space:nowrap;display:inline-block}
.fp-entry-totals .fp-rm-pre{font-style:normal;font-size:12px;font-weight:500;opacity:.65;margin-right:4px;letter-spacing:.2px}
@media(max-width:640px){
  .fp-entry-totals{gap:10px;width:100%;justify-content:space-between}
  .fp-entry-totals div{flex:1;min-width:0}
  .fp-entry-totals b{font-size:14.5px}
  .fp-entry-totals .fp-rm-pre{font-size:10px;margin-right:3px}
  .fp-entry-totals span{font-size:9.5px;letter-spacing:.3px}
}
.pos{color:var(--teal)}.neg{color:var(--pink-light)}.warn{color:var(--amber)}
.fp-entry-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:16px;align-items:start}
.fp-block{padding:16px 16px 8px}
.fp-block-head{display:flex;align-items:center;gap:9px;color:var(--cyan);margin-bottom:12px;padding-bottom:11px;border-bottom:1px solid var(--border-soft)}
.fp-block-head h4{margin:0;font-family:'Chakra Petch';font-size:14px;color:var(--text);font-weight:600;flex:1}

/* Category subtotal pill in header */
.fp-cat-subtotal{font-family:'JetBrains Mono';font-size:11px;font-weight:600;color:var(--cyan-bright);background:var(--bg-2);border:1px solid var(--border);padding:3px 9px;border-radius:20px;letter-spacing:.3px;white-space:nowrap;transition:.15s}
.fp-cat-subtotal:hover{border-color:var(--glow-cyan);color:#a5f3fc}

/* ============================================================
   SAVINGS MODULE
   ============================================================ */
.sv-main{display:flex;flex-direction:column;gap:16px}
.sv-empty{padding:60px 30px;text-align:center;color:var(--text-dim)}
.sv-empty svg{color:var(--border-4);margin-bottom:12px}
.sv-empty h3{margin:0 0 8px;font-family:'Chakra Petch';color:var(--text-2);font-size:15px}
.sv-empty p{margin:0;font-size:12.5px}

/* Account card */
.sv-acc-card{display:flex;justify-content:space-between;gap:24px;padding:18px;align-items:center;flex-wrap:wrap}
.sv-acc-left{display:flex;align-items:center;gap:28px;flex-wrap:wrap;flex:1}
.sv-acc-bank{display:flex;align-items:center;gap:11px}
.sv-acc-bank-logo{width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,var(--green),#10b981);color:var(--bg-2);font-family:'Chakra Petch';font-weight:800;font-size:19px;display:grid;place-items:center;overflow:hidden;flex-shrink:0}
.sv-acc-bank-logo.has-img{background:#1a1340;border:1px solid #2a2050;padding:0}
.sv-acc-bank-logo img{width:100%;height:100%;object-fit:cover;display:block}
.sv-acc-bank-name{font-family:'Chakra Petch';font-size:14.5px;font-weight:600;color:var(--text)}
.sv-acc-bank-meta{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:1px}
.sv-acc-balance-block{flex:1;min-width:240px}
.sv-acc-balance-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);letter-spacing:1.2px;margin-bottom:4px}
.sv-acc-balance{font-family:'JetBrains Mono';font-size:28px;font-weight:700;color:var(--cyan-bright);letter-spacing:-.5px;line-height:1}
.sv-acc-delta{display:flex;align-items:center;gap:9px;margin-top:6px;flex-wrap:wrap}
.sv-acc-delta-pill{display:inline-flex;align-items:center;gap:4px;font-family:'JetBrains Mono';font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px}
.sv-acc-delta-pill.up{color:var(--teal);background:#34d39915;border:1px solid var(--glow-green)}
.sv-acc-delta-pill.down{color:var(--red);background:#fb718515;border:1px solid var(--glow-red)}
.sv-acc-delta-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim)}
.sv-acc-right{display:flex;flex-direction:column;gap:7px;align-items:stretch;min-width:230px}
.sv-acc-actions{display:flex;gap:7px}
.sv-btn-deposit{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;background:linear-gradient(135deg,var(--green),#10b981);color:var(--on-accent);font-family:'Outfit';font-size:12.5px;font-weight:700;padding:10px 14px;border-radius:8px;border:none;cursor:pointer;box-shadow:0 0 14px var(--glow-green-2);transition:.15s;letter-spacing:.3px}
.sv-btn-deposit:hover{box-shadow:0 0 22px var(--glow-green-4);transform:translateY(-1px)}
.sv-btn-withdraw{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;background:linear-gradient(135deg,var(--red),#e11d48);color:#fff;font-family:'Outfit';font-size:12.5px;font-weight:700;padding:10px 14px;border-radius:8px;border:none;cursor:pointer;box-shadow:0 0 14px var(--glow-red-2);transition:.15s;letter-spacing:.3px}
.sv-btn-withdraw:hover{box-shadow:0 0 22px var(--glow-red-3);transform:translateY(-1px)}
.sv-acc-actions-row{display:flex;gap:6px}
.sv-btn-edit-sm{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:10.5px;padding:6px 9px;border-radius:6px;cursor:pointer;transition:.15s}
.sv-btn-edit-sm:hover{border-color:var(--border-2);color:var(--text-2)}

/* Transaction type tabs in snapshot modal */
.sv-tx-tabs{display:flex;gap:5px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:4px;margin-bottom:6px}
.sv-tx-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;background:none;border:none;color:var(--text-dim);font-family:'Outfit';font-size:11.5px;font-weight:600;padding:8px 10px;border-radius:6px;cursor:pointer;transition:.15s;letter-spacing:.3px}
.sv-tx-tab:hover{color:var(--text-2);background:#ffffff04}
.sv-tx-deposit.on{background:linear-gradient(135deg,#34d39920,#10b98115);color:var(--teal);box-shadow:inset 0 0 0 1px var(--glow-green)}
.sv-tx-withdraw.on{background:linear-gradient(135deg,#fb718520,#e11d4815);color:#fda4af;box-shadow:inset 0 0 0 1px var(--glow-red)}
.sv-tx-adjust.on{background:linear-gradient(135deg,#a78bfa20,#7c3aed15);color:var(--purple-light);box-shadow:inset 0 0 0 1px var(--glow-purple)}

/* Transaction preview block */
.sv-tx-preview{background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:11px 13px;display:flex;flex-direction:column;gap:5px;margin-top:-2px}
.sv-tx-prev-row{display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono';font-size:11px}
.sv-tx-prev-row span{color:var(--text-dim);letter-spacing:.3px}
.sv-tx-prev-row b{color:var(--text-2);font-weight:600}
.sv-tx-prev-row b.pos{color:var(--teal)}
.sv-tx-prev-row b.neg{color:var(--red)}
.sv-tx-prev-row b.cyan{color:var(--cyan-bright)}
.sv-tx-prev-delta{padding:3px 0;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border)}
.sv-tx-prev-after b{font-size:13px}

/* Submit button variants */
.sv-tx-submit-withdraw{background:linear-gradient(135deg,var(--red),#e11d48)!important;color:#fff!important;border:none!important}
.sv-tx-submit-withdraw:hover{box-shadow:0 0 18px var(--glow-red-3)!important}
.sv-tx-submit-adjustment{background:linear-gradient(135deg,var(--purple),var(--purple-deep))!important;color:#fff!important;border:none!important}
.sv-tx-submit-adjustment:hover{box-shadow:0 0 18px var(--glow-purple-5)!important}

/* Snapshot row — type-tinted left border */
.sv-snap-deposit{border-left:3px solid var(--glow-green-4)!important}
.sv-snap-withdraw{border-left:3px solid var(--glow-red-3)!important}
.sv-snap-adjustment{border-left:3px solid var(--glow-purple-5)!important}

/* Tx tag inside the row */
.sv-snap-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.sv-snap-tx-tag{font-family:'JetBrains Mono';font-size:8px;letter-spacing:.6px;font-weight:700;padding:1.5px 6px;border-radius:4px;width:fit-content}
.sv-snap-tx-deposit{color:var(--teal);background:#34d39915;border:1px solid var(--glow-green)}
.sv-snap-tx-withdraw{color:#fda4af;background:#fb718515;border:1px solid var(--glow-red)}
.sv-snap-tx-adjustment{color:var(--purple-light);background:#a78bfa15;border:1px solid var(--glow-purple)}

/* This-month flow */
.sv-tmf-body{padding:14px 6px 6px}
.sv-tmf-row{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:11px;align-items:center}
.sv-tmf-step{background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:13px}
.sv-tmf-step-saved{border-color:var(--glow-green);background:linear-gradient(160deg,var(--bg-2),#34d39908)}
.sv-tmf-step-disc{border-color:var(--glow-purple-2);background:linear-gradient(160deg,var(--bg-2),#a78bfa08)}
.sv-tmf-step-personal{border-color:var(--glow-red-2);background:linear-gradient(160deg,var(--bg-2),#fb718508)}
.sv-tmf-step-takehome{border-color:var(--glow-cyan);background:linear-gradient(160deg,var(--bg-2),#22d3ee08)}
.sv-tmf-step-label{font-family:'JetBrains Mono';font-size:9px;color:var(--text-faint);letter-spacing:1.2px;margin-bottom:5px}
.sv-tmf-step-value{font-family:'JetBrains Mono';font-size:17px;font-weight:700;color:var(--text);letter-spacing:-.3px;margin-bottom:3px}
.sv-tmf-step-saved .sv-tmf-step-value{color:var(--teal)}
.sv-tmf-step-disc .sv-tmf-step-value{color:var(--purple-light)}
.sv-tmf-step-personal .sv-tmf-step-value{color:var(--red)}
.sv-tmf-step-takehome .sv-tmf-step-value{color:var(--cyan-bright)}
.sv-tmf-step-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim)}
.sv-tmf-arrow{font-family:'Chakra Petch';font-size:22px;color:var(--text-faint);font-weight:300}
.sv-tmf-target{display:flex;align-items:center;gap:8px;margin:14px 6px 0;padding:9px 12px;background:#a78bfa12;border:1px solid #a78bfa33;border-radius:8px;font-size:11.5px;color:var(--text-2)}
.sv-tmf-target svg{color:var(--purple)}
.sv-tmf-target b{color:var(--purple-light);font-family:'JetBrains Mono'}
.sv-tmf-target-pill{margin-left:auto;font-family:'JetBrains Mono';font-size:10px;padding:3px 9px;border-radius:20px;font-weight:600}
.sv-tmf-target-pill.on{color:var(--teal);background:#34d39915;border:1px solid var(--glow-green)}
.sv-tmf-target-pill.off{color:var(--amber-2);background:#fbbf2415;border:1px solid #fbbf2444}

/* Goals */
.sv-goals-list{display:flex;flex-direction:column;gap:13px;padding:6px 6px}
.sv-goal-row{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:13px;transition:.2s}
.sv-goal-scheduled{background:linear-gradient(160deg,var(--bg-2),var(--dsurf-0));border-color:#1c274088;border-style:dashed}
.sv-goal-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sv-goal-status-tag{font-family:'JetBrains Mono';font-size:8.5px;letter-spacing:.7px;font-weight:700;padding:1.5px 6px;border-radius:4px;display:inline-flex;align-items:center;gap:3px}
.sv-goal-status-active{color:var(--teal);background:#34d39912;border:1px solid var(--glow-green)}
.sv-goal-status-scheduled{color:var(--purple-light);background:#a78bfa12;border:1px solid var(--glow-purple)}
.sv-goal-scheduled .sv-goal-name{color:var(--text-soft)}
.sv-goal-scheduled .sv-goal-current{color:var(--text-muted)!important}
.sv-goal-scheduled .sv-goal-pct{color:var(--text-muted)!important}
.sv-goal-pace-scheduled svg{color:var(--purple)}
.sv-goal-pace-scheduled b{color:var(--purple-light)}

/* Goal form — defer toggle + preview */
.sv-defer-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.sv-defer-toggle input[type=checkbox]{width:14px;height:14px;accent-color:var(--purple);cursor:pointer}
.sv-defer-toggle span{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:.8px;font-weight:600}
.sv-err{display:flex;align-items:center;gap:5px;color:var(--red);font-family:'JetBrains Mono';font-size:10px;margin-top:6px}
.sv-preview{display:flex;align-items:flex-start;gap:7px;margin-top:8px;padding:9px 11px;background:#a78bfa12;border:1px solid var(--glow-purple-2);border-radius:7px;font-size:11px;color:var(--purple-light);line-height:1.5}
.sv-preview svg{color:var(--purple);flex-shrink:0;margin-top:1px}
.sv-preview b{color:var(--text)}
.sv-preview-ok{background:#34d39912;border-color:var(--glow-green-2);color:var(--teal)}
.sv-preview-ok svg{color:var(--green)}
.sv-goal-head{display:flex;align-items:center;gap:11px;margin-bottom:9px}
.sv-goal-icon{width:32px;height:32px;border-radius:8px;border:1px solid;display:grid;place-items:center;flex-shrink:0}
.sv-goal-info{flex:1;min-width:0}
.sv-goal-name{font-family:'Chakra Petch';font-size:13.5px;font-weight:600;color:var(--text)}
.sv-goal-meta{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);margin-top:2px;flex-wrap:wrap}
.sv-goal-amounts{text-align:right}
.sv-goal-current{font-family:'JetBrains Mono';font-size:14px;font-weight:700;color:var(--cyan-bright);letter-spacing:-.2px}
.sv-goal-target{font-family:'JetBrains Mono';font-size:10px;color:var(--text-faint);margin-top:1px}
.sv-goal-edit{background:none;border:1px solid var(--border);color:var(--text-faint);padding:6px;border-radius:6px;cursor:pointer;display:grid;place-items:center;transition:.12s}
.sv-goal-edit:hover{color:var(--purple);border-color:var(--glow-purple)}
.sv-goal-progress{display:flex;align-items:center;gap:10px}
.sv-goal-bar{flex:1;height:8px;background:var(--bg);border-radius:5px;overflow:hidden;border:1px solid #1c274055}
.sv-goal-fill{height:100%;border-radius:4px;transition:width .7s cubic-bezier(.2,.8,.2,1)}
.sv-goal-pct{font-family:'JetBrains Mono';font-size:11px;font-weight:700;color:var(--text-2);min-width:42px;text-align:right}
.sv-goal-pace{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10.5px;color:var(--text-dim);font-family:'JetBrains Mono'}
.sv-goal-pace svg{color:var(--amber-2)}
.sv-goal-pace b{color:var(--text-2)}
.sv-goal-done svg{color:var(--teal)}
.sv-goal-done b{color:var(--teal)}
.sv-goal-add{display:flex;align-items:center;justify-content:center;gap:6px;background:none;border:1px dashed var(--border-2);color:var(--text-dim);padding:11px;border-radius:9px;cursor:pointer;font-family:'Outfit';font-size:12px;transition:.15s}
.sv-goal-add:hover{border-color:var(--cyan);color:var(--cyan-bright);background:#22d3ee08}
.sv-goal-empty{padding:20px;text-align:center;color:var(--text-faint);font-size:12px;display:flex;flex-direction:column;align-items:center;gap:8px}
.sv-goal-empty svg{color:var(--border-4)}

.sv-icon-picker{display:flex;flex-wrap:wrap;gap:6px}
.sv-icon-picker button{width:34px;height:34px;background:var(--surface-3);border:1px solid var(--border);border-radius:7px;color:var(--text-dim);cursor:pointer;display:grid;place-items:center;transition:.15s}
.sv-icon-picker button:hover{border-color:var(--border-2);color:var(--text-2)}
.sv-color-picker{display:flex;gap:8px;flex-wrap:wrap}
.sv-color-picker button{width:24px;height:24px;border:none;border-radius:50%;cursor:pointer;transition:.15s;padding:0}
.sv-color-picker button:hover{transform:scale(1.15)}

/* Snapshot history */
.sv-snap-list{display:flex;flex-direction:column;gap:7px;padding:6px 6px}
.sv-snap-row{display:grid;grid-template-columns:110px 130px 110px 1fr 60px;gap:14px;align-items:center;padding:11px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;transition:.15s}
.sv-snap-row:hover{border-color:var(--border-2)}
.sv-snap-ym{display:flex;flex-direction:column;gap:2px}
.sv-snap-mo{font-family:'JetBrains Mono';font-size:11.5px;font-weight:600;color:var(--text);line-height:1.1}
.sv-snap-latest{font-family:'JetBrains Mono';font-size:8px;color:var(--teal);background:#34d39915;border:1px solid var(--glow-green);padding:1.5px 6px;border-radius:4px;letter-spacing:.6px;font-weight:700;width:fit-content}
.sv-snap-balance-label{font-family:'JetBrains Mono';font-size:8.5px;color:var(--text-faint);letter-spacing:1px;margin-bottom:2px}
.sv-snap-balance-val{font-family:'JetBrains Mono';font-size:13px;font-weight:700;color:var(--cyan-bright)}
.sv-snap-contrib-val{font-family:'JetBrains Mono';font-size:13px;font-weight:700}
.sv-snap-contrib-val.up{color:var(--teal)}
.sv-snap-contrib-val.down{color:var(--red)}
.sv-snap-contrib-val em{color:var(--border-4);font-style:normal}
.sv-snap-note{font-size:11.5px;color:var(--text-2);line-height:1.4}
.sv-snap-note-empty{color:var(--border-4);font-style:italic;font-size:10.5px}
.sv-snap-actions{display:flex;gap:4px;justify-content:flex-end}
.sv-snap-edit{background:none;border:1px solid var(--border);color:var(--text-faint);padding:5px;border-radius:5px;cursor:pointer;display:grid;place-items:center;transition:.12s}
.sv-snap-edit:hover{color:var(--purple);border-color:var(--glow-purple)}
.sv-snap-del:hover{color:var(--red);border-color:var(--glow-red)}
.sv-snap-empty{padding:20px;text-align:center;color:var(--text-faint);font-size:12px}
.sv-snap-more{text-align:center;padding:6px}
.sv-snap-more button{background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'JetBrains Mono';font-size:10.5px;padding:6px 14px;border-radius:6px;cursor:pointer;transition:.15s;letter-spacing:.3px}
.sv-snap-more button:hover{border-color:var(--glow-cyan);color:var(--cyan-bright)}

/* Insights */
.sv-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:11px}

.sv-btn-del{color:var(--pink-light)!important;border-color:#7c1d36!important}
.sv-btn-del:hover{background:#fb718510!important}

@media(max-width:880px){
  .sv-acc-card{flex-direction:column;align-items:stretch}
  .sv-acc-left{flex-direction:column;align-items:stretch;gap:14px}
  .sv-acc-right{flex-direction:row}
  .sv-tmf-row{grid-template-columns:1fr;gap:8px}
  .sv-tmf-arrow{transform:rotate(90deg);text-align:center;justify-self:center}
  .sv-snap-row{grid-template-columns:1fr 1fr;grid-template-areas:"ym actions" "bal contrib" "note note";gap:8px}
  .sv-snap-ym{grid-area:ym}
  .sv-snap-balance{grid-area:bal}
  .sv-snap-contrib{grid-area:contrib}
  .sv-snap-note{grid-area:note}
  .sv-snap-actions{grid-area:actions;justify-self:flex-end}
  .sv-insights{grid-template-columns:repeat(2,1fr)}
}

/* Privacy mode: blur savings amounts */
body.privacy-on .sv-acc-balance,
body.privacy-on .sv-acc-delta-pill,
body.privacy-on .sv-tmf-step-value,
body.privacy-on .sv-tmf-target b,
body.privacy-on .sv-goal-current,
body.privacy-on .sv-goal-target,
body.privacy-on .sv-goal-pace b,
body.privacy-on .sv-snap-balance-val,
body.privacy-on .sv-snap-contrib-val,
body.privacy-on .ln-bal-val,
body.privacy-on .ln-bal-sub,
body.privacy-on .ln-np-amt,
body.privacy-on .ln-stat-val.money,
body.privacy-on .ln-res-val.money,
body.privacy-on .ln-impact-labels b,
body.privacy-on .ln-calc-row > span:last-child,
body.privacy-on .pt-cycle-v,
body.privacy-on .pt-tot-row b,
body.privacy-on .pt-amt,
body.privacy-on .pt-running,
body.privacy-on .pt-cell-amt{
  filter:blur(7px);
  transition:filter .35s cubic-bezier(.22,.61,.36,1);
}
body.privacy-on .sv-acc-balance:hover,
body.privacy-on .sv-acc-delta-pill:hover,
body.privacy-on .sv-tmf-step:hover .sv-tmf-step-value,
body.privacy-on .sv-tmf-target:hover b,
body.privacy-on .sv-goal-row:hover .sv-goal-current,
body.privacy-on .sv-goal-row:hover .sv-goal-target,
body.privacy-on .sv-goal-row:hover .sv-goal-pace b,
body.privacy-on .sv-snap-row:hover .sv-snap-balance-val,
body.privacy-on .sv-snap-row:hover .sv-snap-contrib-val,
body.privacy-on .ln-bal-val:hover,
body.privacy-on .ln-bal-sub:hover,
body.privacy-on .ln-np-amt:hover,
body.privacy-on .ln-stat:hover .ln-stat-val.money,
body.privacy-on .ln-res:hover .ln-res-val.money,
body.privacy-on .ln-impact-labels:hover b,
body.privacy-on .ln-calc-row:hover > span:last-child{
  filter:none;
  transition:filter .12s ease-out;
}

/* Toast — small ephemeral notifications */
.fp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:12px 16px;background:linear-gradient(135deg,var(--dsurf-6),var(--dsurf-2));border:1px solid var(--glow-green);border-radius:10px;box-shadow:0 0 24px var(--glow-green-3),0 18px 50px -10px #000;color:var(--text-2);font-family:'Outfit';font-size:12.5px;line-height:1.4;max-width:480px;z-index:9999;animation:toastIn .25s cubic-bezier(.2,.8,.2,1);cursor:pointer}
@keyframes toastIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translateX(-50%)}}
.fp-toast svg{color:var(--teal);flex-shrink:0}
.fp-toast-x{background:none;border:none;color:var(--text-faint);padding:3px 4px;border-radius:4px;cursor:pointer;display:grid;place-items:center;transition:.12s;margin-left:4px}
.fp-toast-x:hover{color:var(--red)}
.fp-toast-action{background:linear-gradient(135deg,#22d3ee15,#a78bfa15);border:1px solid var(--glow-cyan);color:var(--cyan-bright);font-family:'Outfit';font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:6px;cursor:pointer;transition:.12s;letter-spacing:.3px;margin-left:6px}
.fp-toast-action:hover{border-color:var(--cyan);background:linear-gradient(135deg,#22d3ee25,#a78bfa20);box-shadow:0 0 10px var(--glow-cyan-2)}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.sk{background:linear-gradient(90deg,var(--surface) 0%,var(--border) 40%,var(--border-2) 50%,var(--border) 60%,var(--surface) 100%);background-size:200% 100%;animation:sk 1.6s linear infinite;border-radius:4px;display:inline-block;vertical-align:middle}
.fp-skel-card{background:linear-gradient(160deg,var(--dsurf-5),var(--dsurf-1));border:1px solid var(--border);border-radius:14px;padding:14px;backdrop-filter:blur(6px);margin-bottom:10px}
.fp-help-btn{width:30px;height:30px;border-radius:50%;border:1px solid var(--cyan);background:var(--bg-2);color:var(--cyan-bright);font-family:'Chakra Petch';font-weight:700;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:.15s;margin-left:4px;padding:0;line-height:1}
.fp-theme-toggle{width:30px;height:30px;border-radius:50%;border:1px solid var(--border-2);background:var(--bg-2);color:var(--text-dim);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:.15s;padding:0}
.fp-theme-toggle:hover{border-color:var(--cyan);color:var(--cyan);background:var(--bg-3);box-shadow:0 0 10px var(--glow-cyan-2)}
.fp-help-btn:hover,.fp-help-btn.active{border-color:var(--cyan);background:rgba(34,211,238,0.18);box-shadow:0 0 12px rgba(34,211,238,0.5);color:var(--cyan)}
.fp-help-pop{background:linear-gradient(160deg,var(--dsurf-19),var(--dsurf-12));border:1px solid var(--glow-cyan);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.6),0 0 24px rgba(34,211,238,0.15);padding:14px 14px 10px;width:340px;backdrop-filter:blur(10px);z-index:9999}
.fp-help-arrow{position:absolute;top:-7px;right:14px;width:12px;height:12px;background:var(--surface);border-top:1px solid var(--glow-cyan);border-left:1px solid var(--glow-cyan);transform:rotate(45deg)}
.fp-help-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:grid;place-items:center;z-index:9998;padding:16px;animation:fadeIn .2s ease-out}
.fp-help-pop-mobile{position:relative!important;top:auto!important;right:auto!important;left:auto!important;width:100%!important;max-width:360px!important;max-height:82vh;overflow-y:auto;animation:popUp .25s cubic-bezier(.2,.8,.2,1)}
.fp-help-pop-mobile .fp-help-footer{display:none}
.fp-help-title{font-family:'Chakra Petch';font-size:11px;letter-spacing:1.5px;color:var(--cyan-bright);margin:0 0 10px;text-transform:uppercase;font-weight:600;display:flex;align-items:center;gap:7px;padding-bottom:9px;border-bottom:1px solid var(--border)}
.fp-help-title-ic{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--glow-cyan-3);border:1px solid var(--glow-cyan-4);color:var(--cyan-bright);font-size:9px;font-weight:700}
.fp-help-item{display:flex;align-items:flex-start;gap:11px;padding:9px 6px;border-bottom:1px solid var(--border-3);cursor:default;transition:.12s;border-radius:6px}
.fp-help-item:hover{background:rgba(34,211,238,0.05)}
.fp-help-item:last-child{border-bottom:none}
.fp-help-icon{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.fp-help-name{font-size:12.5px;font-weight:600;color:var(--text-hi);line-height:1.3}
.fp-help-desc{font-size:11px;color:var(--text-dim);margin-top:3px;line-height:1.45}
.fp-help-footer{font-size:10.5px;color:var(--text-faint);text-align:center;padding-top:9px;margin-top:4px;border-top:1px solid var(--border);font-family:'JetBrains Mono'}
.fp-help-kbd{padding:1px 5px;background:var(--border);border-radius:3px;color:#a3b3cf;font-size:9.5px;margin:0 2px}
.fp-inline-help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:rgba(34,211,238,0.1);border:1px solid var(--glow-cyan-2);color:var(--cyan-bright);font-size:9.5px;font-weight:700;cursor:help;margin-left:6px;vertical-align:middle;transition:.12s;font-family:'Chakra Petch';padding:0;line-height:1}
.fp-inline-help:hover,.fp-inline-help:focus-visible{background:rgba(34,211,238,0.22);border-color:var(--cyan);box-shadow:0 0 8px rgba(34,211,238,0.4);outline:none}
.fp-inline-pop{background:linear-gradient(160deg,var(--dsurf-20),var(--dsurf-13));border:1px solid var(--glow-purple);border-radius:8px;padding:10px 12px;width:280px;box-shadow:0 8px 24px rgba(0,0,0,0.5),0 0 16px rgba(167,139,250,0.18);z-index:9998;backdrop-filter:blur(8px)}
.fp-inline-pop-title{font-family:'Chakra Petch';font-size:10px;letter-spacing:1.2px;color:var(--purple-light);margin-bottom:5px;font-weight:600;text-transform:uppercase}
.fp-inline-pop-body{font-size:11.5px;color:var(--text-2);line-height:1.5}
@keyframes tabIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.fp-main{animation:tabIn .35s cubic-bezier(.2,.8,.2,1) both}
.fp-kpi{transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .22s,box-shadow .22s}
.fp-kpi:hover{transform:translateY(-2px);border-color:var(--border-2);box-shadow:0 12px 32px -8px #000,0 0 18px rgba(34,211,238,.08)}
.fp-block{transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .25s}
.fp-block:hover:not(:focus-within){transform:translateY(-1px);border-color:#22d3ee2a}
.fp-insight-card{transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .22s,box-shadow .22s}
.fp-insight-card:hover{transform:translateY(-2px);border-color:var(--border-2);box-shadow:0 12px 32px -8px #000}
@keyframes valPulse{0%{transform:scale(1)}30%{transform:scale(1.06);filter:brightness(1.25)}100%{transform:scale(1);filter:brightness(1)}}
.val-pulse{animation:valPulse .55s cubic-bezier(.2,.8,.2,1);display:inline-flex;transform-origin:left center}
.sk{transition:opacity .25s ease-out}
.fp-skel-card{transition:opacity .3s ease-out}
.fp-copy-month-btn{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,rgba(167,139,250,0.18),rgba(124,58,237,0.12));border:1px solid var(--glow-purple-3);color:var(--purple-light);font-family:'Outfit';font-size:11.5px;font-weight:500;padding:6px 12px;border-radius:8px;cursor:pointer;transition:.15s;margin-top:8px}
.fp-copy-month-btn:hover{border-color:var(--purple);background:linear-gradient(135deg,rgba(167,139,250,0.28),rgba(124,58,237,0.18));box-shadow:0 0 14px rgba(167,139,250,0.35);transform:translateY(-1px)}
.fp-copy-month-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.fp-copy-month-arrow{color:var(--cyan-bright);font-family:'Chakra Petch';font-weight:700}
.cm-flow{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:14px;flex-wrap:wrap}
.cm-flow-box{background:rgba(34,211,238,0.08);border:1px solid var(--glow-cyan);border-radius:8px;padding:9px 14px;min-width:130px;text-align:center}
.cm-flow-box.target{background:rgba(167,139,250,0.1);border-color:var(--glow-purple-3)}
.cm-flow-label{font-family:'JetBrains Mono';font-size:9px;color:var(--text-faint);letter-spacing:1px;margin-bottom:3px}
.cm-flow-month{font-family:'Chakra Petch';font-size:14px;font-weight:600;color:var(--cyan-bright)}
.cm-flow-box.target .cm-flow-month{color:var(--purple-light)}
.cm-flow-arrow{color:var(--text-faint);font-size:18px}
.cm-month-sel{display:flex;gap:6px;margin-top:6px;justify-content:center}
.cm-month-sel select{background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text-2);font-family:'JetBrains Mono';font-size:11px;cursor:pointer}
.cm-current{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:8px}
.cm-mode{display:flex;gap:0;margin:12px 0 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:3px}
.cm-mode-opt{flex:1;padding:8px 10px;background:transparent;border:none;color:var(--text-dim);font-size:11px;cursor:pointer;border-radius:6px;font-family:'Outfit';transition:.12s}
.cm-mode-opt.on{background:linear-gradient(135deg,#22d3ee18,#a78bfa12);color:var(--cyan-bright);box-shadow:0 0 0 1px var(--glow-cyan-2) inset}
.cm-mode-desc{font-size:11px;color:var(--text-dim);padding:0 4px 6px;line-height:1.5}
.cm-mode-desc b{color:var(--teal);font-weight:600}
.cm-preview{background:var(--dsurf-9);border:1px solid var(--border-3);border-radius:8px;padding:10px 12px;margin-top:6px;max-height:200px;overflow-y:auto}
.cm-preview-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:11.5px}
.cm-preview-name{color:var(--text-2)}
.cm-preview-amt{color:var(--cyan-bright);font-family:'JetBrains Mono'}
.cm-preview-amt.skip{color:var(--text-faint);text-decoration:line-through}
.cm-skip-label{color:var(--text-faint);font-size:9.5px;text-decoration:none;margin-left:6px;font-family:'Outfit';font-style:italic}
.cm-preview-stat{font-size:10.5px;color:var(--text-dim);padding-top:8px;margin-top:6px;border-top:1px solid var(--border-3);display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px}
.cm-preview-stat b{font-family:'JetBrains Mono';font-weight:600}
.cm-preview-empty{padding:20px;text-align:center;font-size:11px;color:var(--text-faint);font-style:italic}
.fp-clear-month-btn{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,rgba(244,114,182,0.10),rgba(190,18,60,0.08));border:1px solid var(--glow-pink);color:var(--pink-light);font-family:'Outfit';font-size:11.5px;font-weight:500;padding:6px 12px;border-radius:8px;cursor:pointer;transition:.15s;margin-top:8px;margin-left:8px}
.fp-clear-month-btn:hover:not(:disabled){border-color:var(--pink);background:linear-gradient(135deg,rgba(244,114,182,0.22),rgba(190,18,60,0.15));box-shadow:0 0 14px rgba(244,114,182,0.3);transform:translateY(-1px)}
.fp-clear-month-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.cm-warn{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;background:rgba(244,114,182,0.08);border:1px solid #f472b644;border-radius:8px;margin-bottom:12px;font-size:11.5px;color:var(--pink-light);line-height:1.5}
.cm-warn svg{flex-shrink:0;margin-top:1px;color:var(--pink)}
.cm-warn b{color:var(--red)}
.cm-clear-list{background:var(--dsurf-9);border:1px solid var(--border-3);border-radius:8px;padding:10px 12px;max-height:200px;overflow-y:auto}
.cm-clear-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:11.5px}
.cm-clear-name{color:var(--text-2)}
.cm-clear-amt{color:var(--pink-light);font-family:'JetBrains Mono'}
.cm-clear-stat{font-size:10.5px;color:var(--text-dim);padding-top:8px;margin-top:6px;border-top:1px solid var(--border-3);text-align:right}
.cm-clear-stat b{font-family:'JetBrains Mono';color:var(--pink-light)}
.ib-btn-danger{background:linear-gradient(135deg,var(--red),#be123c);border:1px solid var(--red);color:#fff;padding:7px 14px;border-radius:7px;font-family:'Outfit';font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ib-btn-danger:hover:not(:disabled){box-shadow:0 0 14px rgba(244,114,182,0.55)}
.ib-btn-danger:disabled{opacity:.5;cursor:not-allowed}
/* ===== LOAN TAB (Car / House) ===== */
.ln-main{padding:18px 28px;display:flex;flex-direction:column;gap:12px}
.ln-hero{display:grid;grid-template-columns:280px 1fr;gap:22px;align-items:stretch;background:linear-gradient(135deg,var(--surface-2),var(--bg-2));border:1px solid var(--border);border-radius:14px;padding:22px 24px;position:relative;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.45),0 0 0 1px rgba(255,255,255,0.02) inset,0 1px 0 0 rgba(255,255,255,0.05) inset}
.ln-hero.car{background:radial-gradient(ellipse 60% 80% at 0% 50%,rgba(93,206,240,0.06),transparent 70%),radial-gradient(ellipse 50% 100% at 100% 0%,rgba(245,193,75,0.04),transparent 65%),linear-gradient(135deg,var(--surface-2),var(--bg-2))}
.ln-hero.house{background:radial-gradient(ellipse 60% 80% at 0% 50%,rgba(255,215,0,0.06),transparent 70%),radial-gradient(ellipse 50% 100% at 100% 0%,rgba(94,234,212,0.04),transparent 65%),linear-gradient(135deg,var(--surface-2),var(--bg-2))}
.ln-hero::before{content:'';position:absolute;top:0;bottom:0;left:300px;width:80px;background:linear-gradient(90deg,rgba(255,215,0,0.04),transparent);pointer-events:none;z-index:0}
.ln-hero.car::before{background:linear-gradient(90deg,rgba(93,206,240,0.04),transparent)}
.ln-hero > *{position:relative;z-index:1}
.ln-photo{background:var(--bg-2);border-radius:10px;border:1px solid var(--border);overflow:hidden;display:flex;align-items:center;justify-content:center;align-self:center}
.ln-photo img{width:100%;height:auto;display:block}
.ln-photo-placeholder{font-family:'JetBrains Mono';font-size:11px;color:var(--text-faint);padding:60px 30px;text-align:center;width:100%}
.ln-hero-info{display:flex;flex-direction:column;justify-content:flex-start;position:relative;z-index:1}
.ln-hero-meta{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-faint);letter-spacing:1.4px;margin-bottom:5px;text-transform:uppercase}
.ln-hero-name{font-family:'Chakra Petch';font-size:28px;font-weight:700;color:var(--text);letter-spacing:-0.4px;line-height:1.1;margin:0 0 14px}
.ln-hero-sub{font-family:'JetBrains Mono';font-size:11.5px;color:var(--text-dim);display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.ln-hero-sub span{display:inline-flex;align-items:center;gap:5px}
.ln-color-chip{width:10px;height:10px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,0.2)}
.ln-hero-balance{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ln-bal-block{position:relative;background:var(--dsurf-15);backdrop-filter:blur(16px) saturate(120%);-webkit-backdrop-filter:blur(16px) saturate(120%);border:1px solid rgba(251,113,133,0.18);border-radius:11px;padding:13px 15px;box-shadow:0 6px 18px rgba(0,0,0,0.25),0 0 0 1px rgba(255,255,255,0.02) inset;transition:.2s}
.ln-bal-block:hover{border-color:rgba(251,113,133,0.35);transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,0.3),0 0 0 1px rgba(255,255,255,0.03) inset,0 0 18px rgba(251,113,133,0.08)}
.ln-bal-block::before{content:'';position:absolute;top:0;left:12px;right:12px;height:1px;background:linear-gradient(90deg,transparent,rgba(251,113,133,0.5),transparent)}
.ln-bal-block.right{border-color:rgba(94,234,212,0.18)}
.ln-bal-block.right:hover{border-color:rgba(94,234,212,0.35);box-shadow:0 10px 24px rgba(0,0,0,0.3),0 0 0 1px rgba(255,255,255,0.03) inset,0 0 18px rgba(94,234,212,0.1)}
.ln-bal-block.right::before{background:linear-gradient(90deg,transparent,rgba(94,234,212,0.5),transparent)}
.ln-bal-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:1.6px;margin-bottom:6px;text-transform:uppercase}
.ln-bal-val{font-family:'JetBrains Mono';font-size:26px;font-weight:700;letter-spacing:-.4px;line-height:1.05}
.ln-bal-val.outstanding{color:var(--red)}
.ln-bal-val.paid{color:var(--teal)}
.ln-bal-val.principal{color:var(--cyan-bright)}
.ln-bal-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:5px}
.ln-snapshot-tag{display:inline-block;font-family:'JetBrains Mono';font-size:9.5px;color:var(--purple);background:rgba(167,139,250,0.08);border:1px solid var(--glow-purple-2);padding:2px 7px;border-radius:14px;margin-top:5px;letter-spacing:.4px}
.ln-snapshot-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:5px}
.ln-snapshot-row .ln-snapshot-tag{margin-top:0}
.ln-undo-link{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:transparent;border:1px dashed rgba(125,138,163,0.3);border-radius:14px;font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);cursor:pointer;transition:.15s;letter-spacing:.4px}
.ln-undo-link:hover{border-color:var(--glow-purple-3);color:var(--purple-light);background:rgba(167,139,250,0.06);border-style:solid}
.ln-undo-link:disabled{opacity:.5;cursor:wait}
.ln-undo-link svg{width:10px;height:10px}

.ln-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.ln-stat{background:linear-gradient(160deg,var(--dsurf-17),var(--dsurf-10));border:1px solid var(--border);border-radius:12px;padding:13px 14px;transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}
.ln-stat:hover{transform:translateY(-2px);border-color:var(--border-2);box-shadow:0 12px 32px -8px #000,0 0 18px rgba(34,211,238,.08)}
.ln-stat-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.ln-stat-label{font-size:10.5px;color:var(--text-dim);letter-spacing:1.2px;font-family:'JetBrains Mono';text-transform:uppercase}
.ln-stat-ic{width:26px;height:26px;border-radius:8px;display:grid;place-items:center}
.ln-stat-val{font-family:'JetBrains Mono';font-size:18px;font-weight:700;letter-spacing:-.3px;line-height:1.1}
.ln-stat-sub{font-size:10.5px;color:var(--text-faint);margin-top:4px;font-family:'JetBrains Mono'}
.ln-stat-sub b{color:var(--text-2);font-weight:600}

.ln-progress-card{padding:13px 16px;background:linear-gradient(160deg,var(--dsurf-17),var(--dsurf-10));border:1px solid var(--border);border-radius:12px}
.ln-progress-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;font-size:11.5px;color:var(--text-dim);font-family:'JetBrains Mono'}
.ln-progress-head b{color:var(--text-hi);font-weight:600}
.ln-bar{height:10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;overflow:hidden;position:relative}
.ln-bar-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,var(--red),var(--cyan))}
.ln-bar-fill.house{background:linear-gradient(90deg,var(--purple),var(--teal))}
.ln-bar-ticks{display:flex;justify-content:space-between;margin-top:5px;font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint)}

.ln-card{background:linear-gradient(160deg,var(--dsurf-17),var(--dsurf-10));border:1px solid var(--border);border-radius:14px;padding:14px 16px}
.ln-card-title{font-family:'Chakra Petch';font-size:13.5px;font-weight:600;color:var(--text-hi);display:flex;align-items:center;gap:8px;margin:0 0 11px;padding-bottom:10px;border-bottom:1px solid var(--border-soft)}
.ln-card-title .ln-tag{font-family:'JetBrains Mono';font-size:10px;color:var(--text-faint);background:var(--bg-2);border:1px solid var(--border);padding:2px 8px;border-radius:18px;margin-left:auto;font-weight:400;letter-spacing:.4px}
.ln-calc-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;font-family:'JetBrains Mono';font-size:12px;border-bottom:1px dashed var(--border-3)}
.ln-calc-row:last-child{border-bottom:none}
.ln-calc-row span:first-child{color:var(--text-2);display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.ln-calc-row span:first-child em{font-style:normal;color:var(--text-faint);font-size:10px;background:var(--bg-2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;flex-shrink:0}
.ln-calc-row.sub{color:var(--text-dim);font-size:11px;padding:5px 0 5px 22px;border-bottom:none}
.ln-calc-row.sub span:first-child{color:var(--text-dim)}
.ln-calc-row.total{padding-top:11px;margin-top:6px;border-top:2px solid var(--border);border-bottom:none;font-weight:700;font-size:13.5px}
.ln-calc-row.total span:first-child{color:var(--text-hi)}
.ln-calc-row.formula{background:rgba(34,211,238,0.06);padding:9px 12px;border-radius:6px;border:1px solid #22d3ee2a;border-bottom:none;margin:5px 0;font-size:11px}
.ln-calc-row.formula span:first-child{color:var(--cyan-bright)}
.ln-calc-row.formula span:last-child{color:var(--text-2)}
.ln-calc-pos{color:var(--teal);font-weight:700}
.ln-calc-neg{color:var(--red);font-weight:700}
.ln-calc-warn{color:var(--amber);font-weight:700}
.ln-calc-accent{color:var(--cyan-bright);font-weight:700}

.ln-amort-chart{display:flex;align-items:flex-end;gap:1px;height:120px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px 0;position:relative;overflow:hidden}
.ln-amort-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;position:relative;min-width:0}
.ln-amort-int{background:var(--pink);border-radius:1px}
.ln-amort-prin{background:var(--cyan);border-radius:1px}
.ln-amort-col.paid .ln-amort-int{background:var(--glow-pink)}
.ln-amort-col.paid .ln-amort-prin{background:var(--glow-cyan)}
.ln-amort-marker{position:absolute;top:5px;width:2px;background:var(--purple);box-shadow:0 0 6px var(--purple);height:calc(100% - 10px)}
.ln-amort-legend{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);flex-wrap:wrap;gap:8px}
.ln-amort-legend-items{display:flex;gap:14px;flex-wrap:wrap}
.ln-amort-legend-items span{display:inline-flex;align-items:center;gap:5px}
.ln-amort-legend-items span::before{content:'';width:9px;height:9px;border-radius:2px;flex-shrink:0}
.ln-leg-int::before{background:var(--pink)}
.ln-leg-prin::before{background:var(--cyan)}
.ln-leg-cur::before{background:var(--purple);width:2px!important;height:10px!important;box-shadow:0 0 4px var(--purple)}

.ln-snap-btn{display:inline-flex;align-items:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11px;font-weight:500;padding:6px 11px;border-radius:7px;cursor:pointer;transition:.15s}
.ln-snap-btn:hover{border-color:var(--glow-purple-3);color:var(--purple-light);background:rgba(167,139,250,0.06)}

.ln-empty{display:flex;flex-direction:column;align-items:center;gap:14px;padding:60px 30px;color:var(--text-dim);text-align:center}
.ln-empty svg{color:#3a4a6a}

/* ---- NEXT PAYMENT WIDGET (5 states) ---- */
.ln-np{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:13px 16px;border-radius:12px;border:1px solid var(--border);background:linear-gradient(160deg,var(--dsurf-18),var(--dsurf-11));position:relative;overflow:hidden;transition:.3s}
.ln-np::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;transition:background .3s}
.ln-np.paid::before{background:linear-gradient(180deg,var(--teal-2),#4ade80)}
.ln-np.scheduled::before{background:linear-gradient(180deg,#5dcef0,var(--cyan-bright))}
.ln-np.soon::before{background:linear-gradient(180deg,#f5c14b,var(--amber))}
.ln-np.urgent::before{background:linear-gradient(180deg,var(--orange),#fb923c)}
.ln-np.overdue::before{background:linear-gradient(180deg,var(--red-2),#dc2626)}
.ln-np.paid{box-shadow:0 0 0 1px #5dd39e2a inset}
.ln-np.scheduled{box-shadow:0 0 0 1px #5dcef02a inset}
.ln-np.soon{box-shadow:0 0 0 1px #f5c14b2a inset}
.ln-np.urgent{box-shadow:0 0 18px #ff95541a,0 0 0 1px #ff95545a inset}
.ln-np.overdue{box-shadow:0 0 22px #ff54701a,0 0 0 1px #ff547066 inset}
.ln-np-ic{width:42px;height:42px;border-radius:10px;display:grid;place-items:center;flex-shrink:0;transition:.3s;position:relative}
.ln-np.paid .ln-np-ic{background:#5dd39e15;border:1px solid #5dd39e55;color:var(--teal-2)}
.ln-np.scheduled .ln-np-ic{background:#5dcef015;border:1px solid #5dcef044;color:var(--cyan-bright)}
.ln-np.soon .ln-np-ic{background:#f5c14b15;border:1px solid #f5c14b44;color:var(--amber)}
.ln-np.urgent .ln-np-ic{background:#ff955415;border:1px solid #ff95545a;color:var(--orange)}
.ln-np.overdue .ln-np-ic{background:#ff547015;border:1px solid #ff547066;color:var(--red-2)}
.ln-np.urgent .ln-np-ic,.ln-np.overdue .ln-np-ic{animation:lnPulseRing 1.8s infinite}
@keyframes lnPulseRing{0%{box-shadow:0 0 0 0 currentColor}100%{box-shadow:0 0 0 8px transparent}}
.ln-np-mid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ln-np-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);letter-spacing:1.4px;text-transform:uppercase}
.ln-np-amt{font-family:'JetBrains Mono';font-size:22px;font-weight:700;letter-spacing:-.3px;line-height:1.1}
.ln-np.paid .ln-np-amt{color:var(--teal-2)}
.ln-np.scheduled .ln-np-amt{color:var(--cyan-bright)}
.ln-np.soon .ln-np-amt{color:var(--amber)}
.ln-np.urgent .ln-np-amt{color:var(--orange)}
.ln-np.overdue .ln-np-amt{color:var(--red-2)}
.ln-np-info{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-dim);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}
.ln-np-info b{color:var(--text-2);font-weight:600}
.ln-np-right{display:flex;flex-direction:column;gap:5px;align-items:flex-end}
.ln-np-countdown{font-family:'Chakra Petch';font-size:15px;font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:5px}
.ln-np.paid .ln-np-countdown{color:var(--teal-2)}
.ln-np.scheduled .ln-np-countdown{color:var(--cyan-bright)}
.ln-np.soon .ln-np-countdown{color:var(--amber)}
.ln-np.urgent .ln-np-countdown{color:var(--orange)}
.ln-np.overdue .ln-np-countdown{color:var(--red-2)}
.ln-np-date{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim)}
.ln-np-mark{display:inline-flex;align-items:center;gap:5px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11px;font-weight:500;padding:6px 12px;border-radius:7px;cursor:pointer;transition:.15s;margin-top:2px}
.ln-np-mark:hover:not(:disabled){border-color:#5eead466;color:var(--teal);background:rgba(94,234,212,0.08)}
.ln-np-mark:disabled{opacity:.5;cursor:wait}
.ln-np-mark.ghost{background:transparent;border-color:rgba(125,138,163,0.25);color:var(--text-faint)}
.ln-np-mark.ghost:hover:not(:disabled){background:rgba(125,138,163,0.08);color:var(--text-dim);border-color:rgba(125,138,163,0.4)}

/* ---- WHAT-IF SLIDER ---- */
.ln-sl-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-family:'JetBrains Mono';font-size:11px;color:var(--text-dim)}
.ln-sl-val{font-family:'JetBrains Mono';font-size:18px;font-weight:700;color:var(--purple-light);letter-spacing:-.3px}
.ln-sl{appearance:none;width:100%;height:6px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;outline:none;cursor:pointer;margin:5px 0 16px;background-image:linear-gradient(90deg,var(--purple),var(--purple-light));background-size:0% 100%;background-repeat:no-repeat}
.ln-sl::-webkit-slider-thumb{appearance:none;width:18px;height:18px;background:var(--purple-light);border:2px solid var(--bg);border-radius:50%;cursor:pointer;box-shadow:0 0 12px var(--glow-purple-3)}
.ln-sl::-moz-range-thumb{width:18px;height:18px;background:var(--purple-light);border:2px solid var(--bg);border-radius:50%;cursor:pointer;box-shadow:0 0 12px var(--glow-purple-3)}
.ln-sl-ticks{display:flex;justify-content:space-between;margin-top:-12px;margin-bottom:14px;font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);padding:0 9px}
.ln-results{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.ln-res{padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg-2);transition:.2s}
.ln-res.cyan{border-color:#22d3ee2a;background:rgba(34,211,238,0.04)}
.ln-res.teal{border-color:#5eead42a;background:rgba(94,234,212,0.04)}
.ln-res.purple{border-color:#a78bfa2a;background:rgba(167,139,250,0.04)}
.ln-res-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);letter-spacing:1.3px;margin-bottom:6px;text-transform:uppercase}
.ln-res-val{font-family:'JetBrains Mono';font-size:20px;font-weight:700;letter-spacing:-.4px;line-height:1.1}
.ln-res.cyan .ln-res-val{color:var(--cyan-bright)}
.ln-res.teal .ln-res-val{color:var(--teal)}
.ln-res.purple .ln-res-val{color:var(--purple-light)}
.ln-res-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:4px}
.ln-res-sub b{color:var(--text-2);font-weight:600}
.ln-impact-bar{height:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:5px;overflow:hidden;margin-top:10px;display:flex}
.ln-impact-orig{background:linear-gradient(90deg,var(--red),var(--pink));transition:width .3s}
.ln-impact-saved{background:linear-gradient(90deg,var(--teal),var(--cyan));transition:width .3s}
.ln-impact-labels{display:flex;justify-content:space-between;margin-top:6px;font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);flex-wrap:wrap;gap:6px}
.ln-impact-labels b{font-weight:700;color:var(--text-2)}
.ln-note{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-dim);background:rgba(167,139,250,0.05);border:1px solid var(--glow-purple-4);border-radius:6px;padding:8px 11px;margin-top:10px;line-height:1.5}
.ln-note b{color:var(--purple-light);font-weight:600}

/* ---- UPDATE SNAPSHOT MODAL ---- */
.ln-snap-btn-hdr{display:inline-flex;align-items:center;gap:5px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:10.5px;font-weight:500;padding:5px 10px;border-radius:6px;cursor:pointer;transition:.15s;margin-left:auto}
.ln-snap-btn-hdr:hover{border-color:var(--glow-purple-3);color:var(--purple-light);background:rgba(167,139,250,0.06)}
.ln-modal-overlay{position:fixed;inset:0;background:var(--dsurf-25);backdrop-filter:blur(4px);display:grid;place-items:center;z-index:9999;animation:overlayIn .15s ease;padding:14px}
@keyframes overlayIn{from{opacity:0}to{opacity:1}}
.ln-modal{background:linear-gradient(160deg,var(--surface),var(--bg-3));border:1px solid #2a3a5a;border-radius:13px;padding:16px 18px;width:100%;max-width:420px;box-shadow:0 24px 60px -10px #000,0 0 40px rgba(167,139,250,0.15);animation:modalIn .2s ease;max-height:calc(100vh - 28px);display:flex;flex-direction:column;overflow:hidden}
.ln-modal-scroll{overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;margin:0 -18px;padding:0 18px}
.ln-modal-h{flex-shrink:0}
@keyframes modalIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.ln-modal-h{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;padding-bottom:11px;border-bottom:1px solid var(--border)}
.ln-modal-title{font-family:'Chakra Petch';font-size:14.5px;font-weight:600;color:var(--text-hi);line-height:1.2}
.ln-modal-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:3px}
.ln-modal-x{background:transparent;border:none;color:var(--text-faint);cursor:pointer;padding:4px;line-height:1;display:grid;place-items:center}
.ln-modal-x:hover{color:var(--text-2)}
.ln-prev-block{padding:9px 11px;background:rgba(167,139,250,0.06);border:1px solid #a78bfa2a;border-radius:8px;margin-bottom:12px}
.ln-prev-l{font-family:'JetBrains Mono';font-size:9.5px;color:var(--purple);letter-spacing:1.2px;margin-bottom:6px;text-transform:uppercase}
.ln-prev-r{display:flex;justify-content:space-between;font-family:'JetBrains Mono';font-size:11px;color:var(--text-2);padding:2px 0}
.ln-prev-r span:first-child{color:var(--text-dim)}
.ln-qa-strip{display:flex;align-items:center;gap:9px;padding:9px 11px;background:rgba(94,234,212,0.06);border:1px solid #5eead42a;border-radius:8px;margin-bottom:12px;cursor:pointer;transition:.15s;width:100%;text-align:left;font-family:inherit}
.ln-qa-strip:hover{background:rgba(94,234,212,0.10);border-color:#5eead466}
.ln-qa-ic{width:26px;height:26px;border-radius:7px;background:#5eead418;border:1px solid #5eead455;color:var(--teal);display:grid;place-items:center;flex-shrink:0}
.ln-qa-body{font-size:11px;color:var(--text-2);line-height:1.4;flex:1}
.ln-qa-body b{color:var(--teal);font-weight:600}
.ln-qa-body span{color:var(--text-dim);font-family:'JetBrains Mono';font-size:10px;display:block;margin-top:2px}
.ln-qa-arrow{color:var(--teal);font-size:14px}
.ln-field{margin-bottom:11px}
.ln-field-l{display:block;font-family:'Outfit';font-size:11px;color:var(--text-2);margin-bottom:5px;font-weight:500}
.ln-field-l em{font-style:normal;color:var(--text-faint);font-size:10px;margin-left:5px;font-weight:400}
.ln-field-i{display:flex;align-items:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;padding:0 10px;transition:.15s}
.ln-field-i:focus-within{border-color:var(--purple);box-shadow:0 0 0 1px var(--glow-purple-2)}
.ln-field-i .pfx{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-faint)}
.ln-field-i input{flex:1;background:none;border:none;outline:none;color:var(--text-hi);font-family:'JetBrains Mono';font-size:13px;font-weight:500;padding:8px 0;width:100%}
.ln-field-i input[type="date"]{color:var(--text-2);color-scheme:dark}
.ln-field-i select{flex:1;background:none;border:none;outline:none;color:var(--text-hi);font-family:'JetBrains Mono';font-size:13px;font-weight:500;padding:8px 0;width:100%;cursor:pointer}
.ln-field-i select option{background:var(--surface-2);color:var(--text-hi)}
.ln-field-i textarea{flex:1;background:none;border:none;outline:none;color:var(--text-hi);font-family:'Outfit';font-size:12.5px;padding:8px 0;width:100%;resize:vertical;min-height:60px;line-height:1.5}
.ln-field-i .sfx{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-faint);flex-shrink:0}
/* ---- EDIT LOAN MODAL specifics ---- */
.ln-form-grid{display:grid;gap:13px}
.ln-form-row{display:grid;gap:13px}
.ln-form-row.two{grid-template-columns:1fr 1fr}
.ln-form-row.three{grid-template-columns:1fr 1fr 1fr}
.ln-edit-label{font-family:'JetBrains Mono';font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-dim);margin-bottom:5px;display:flex;align-items:center;gap:5px}
.ln-edit-label .help{color:var(--text-faint);font-size:9.5px;letter-spacing:.5px;text-transform:none;font-weight:400}
.ln-seg-control{display:flex;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;padding:3px;gap:2px}
.ln-seg-control button{flex:1;background:transparent;border:none;color:var(--text-dim);font-family:'Outfit';font-size:11.5px;font-weight:500;padding:7px 10px;border-radius:5px;cursor:pointer;transition:.15s}
.ln-seg-control button.active{background:rgba(93,206,240,0.15);color:#5dcef0;box-shadow:0 0 0 1px #5dcef044 inset}
.ln-seg-control button:hover:not(.active){color:var(--text-bright)}
.ln-locked-section{margin-top:14px;padding:11px 13px;background:var(--dsurf-14);border:1px dashed var(--border);border-radius:8px}
.ln-locked-l{font-family:'JetBrains Mono';font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-faint);margin-bottom:8px;display:flex;align-items:center;gap:5px}
.ln-locked-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px}
.ln-locked-item{font-family:'JetBrains Mono';font-size:11px;color:var(--text-dim)}
.ln-locked-item span{color:var(--text-faint);display:block;font-size:9.5px;margin-bottom:2px;letter-spacing:.8px;text-transform:uppercase}
.ln-modal-foot{padding:14px 0 4px;border-top:1px solid var(--border);margin-top:0;padding-top:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-shrink:0;background:transparent}
.ln-modal-status{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-faint)}
.ln-modal-status.changed{color:var(--amber)}
.ln-modal-actions{display:flex;gap:8px}
.ln-btn{padding:8px 16px;border-radius:7px;font-family:'Outfit';font-size:12.5px;font-weight:500;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent}
.ln-btn-secondary{background:transparent;border-color:rgba(125,138,163,0.3);color:var(--text-bright)}
.ln-btn-secondary:hover{background:rgba(125,138,163,0.08)}
.ln-btn-primary{background:linear-gradient(135deg,#9b59ff,#5dcef0);color:#fff}
.ln-btn-primary:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(155,89,255,0.3)}
.ln-btn-primary:disabled{opacity:.4;cursor:not-allowed}
.ln-edit-btn-hdr{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,rgba(155,89,255,0.18),rgba(93,206,240,0.12));border:1px solid var(--glow-purple);color:var(--purple-light);font-family:'Outfit';font-size:10.5px;font-weight:500;padding:5px 10px;border-radius:6px;cursor:pointer;transition:.15s;margin-left:auto}
/* ---- DASHBOARD LOANS SUMMARY CARD ---- */
.fp-loans-card{position:relative;overflow:hidden;background:linear-gradient(135deg,rgba(255,149,84,0.04),rgba(94,234,212,0.03)),linear-gradient(135deg,var(--surface-2),var(--bg-2));border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin:18px 0 22px}
.pt-wrap{padding:18px 20px;margin:18px 0 22px}
.pt-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.pt-title-row{display:flex;align-items:center;gap:9px}
.pt-zap{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,var(--glow-cyan-3),var(--glow-purple-4));border:1px solid var(--glow-cyan);color:var(--cyan-bright);display:grid;place-items:center}
.pt-zap svg{width:14px;height:14px}
.pt-title{font-family:'Chakra Petch';font-size:15px;font-weight:600;color:var(--text)}
.pt-toggle{display:flex;gap:4px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:3px}
.pt-toggle button{display:flex;align-items:center;gap:5px;padding:6px 12px;border:none;border-radius:6px;background:transparent;color:var(--text-dim);font-family:'Outfit';font-size:11.5px;font-weight:600;cursor:pointer;transition:.15s}
.pt-toggle button.on{background:linear-gradient(135deg,var(--cyan),var(--cyan-bright));color:var(--on-accent)}
.pt-cycle{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:14px 16px;background:var(--bg-2);border:1px solid var(--border);border-radius:11px;margin-bottom:16px;flex-wrap:wrap}
.pt-cycle-l{font-family:'JetBrains Mono';font-size:9px;letter-spacing:1.2px;color:var(--text-faint);margin-bottom:5px}
.pt-cycle-v{font-family:'JetBrains Mono';font-size:24px;font-weight:700;color:var(--cyan-bright);letter-spacing:-.5px;white-space:nowrap}
.pt-cycle-v i{font-style:normal;font-size:14px;opacity:.7;margin-right:5px}
.pt-cycle-sub{font-family:'Outfit';font-size:10.5px;color:var(--text-faint);margin-top:3px}
.pt-cycle-tot{display:flex;flex-direction:column;gap:6px;text-align:right}
.pt-tot-row{display:flex;align-items:center;gap:10px;justify-content:flex-end;font-family:'JetBrains Mono';font-size:11px}
.pt-tot-row span{font-size:10px;min-width:52px;text-align:left}
.pt-tot-row b{color:var(--text);min-width:84px;text-align:right}
.pt-tot-row.pt-paid span{color:var(--green)}
.pt-tot-row.pt-due span{color:var(--amber)}
.pt-list{position:relative}
.pt-spine{position:absolute;left:19px;top:8px;bottom:8px;width:2px;background:var(--border)}
.pt-row{display:flex;align-items:center;gap:11px;padding:6px 0;position:relative}
.pt-daycol{width:40px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;z-index:1}
.pt-day{font-family:'JetBrains Mono';font-size:9px;color:var(--text-dim);margin-bottom:2px}
.pt-dot{width:14px;height:14px;border-radius:50%;background:var(--bg);display:grid;place-items:center;color:var(--bg)}
.pt-dot.pt-house{border:2px solid var(--amber)}
.pt-dot.pt-car{border:2px solid var(--cyan)}
.pt-dot.pt-inst{border:2px solid var(--purple)}
.pt-dot.paid{background:var(--green);border-color:var(--green)}
.pt-item{flex:1;display:flex;align-items:center;gap:10px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:9px 12px;min-width:0}
.pt-item.paid{background:var(--pt-paid-bg);border-color:var(--pt-paid-border);opacity:1}
.pt-ic{position:relative;width:28px;height:28px;border-radius:7px;flex-shrink:0;display:block}
.pt-ic svg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px!important;height:14px!important}
.pt-ic.pt-house{background:rgba(252,211,77,.13);color:var(--amber)}
.pt-ic.pt-car{background:var(--glow-cyan-3);color:var(--cyan)}
.pt-ic.pt-inst{background:var(--glow-purple-4);color:var(--purple)}
.pt-item-body{flex:1;min-width:0}
.pt-item-name{font-family:'Outfit';font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt-item-sub{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-2);opacity:.92;margin-top:2px}
.pt-item-amt{text-align:right;flex-shrink:0}
.pt-amt{font-family:'JetBrains Mono';font-size:12.5px;font-weight:600;color:var(--text)}
.pt-item.paid .pt-amt{color:var(--green)}
.pt-running{font-family:'JetBrains Mono';font-size:9px;color:var(--text-dim);margin-top:2px}
.pt-grid-wrap{}
.pt-legend{display:flex;gap:16px;justify-content:flex-end;margin-bottom:10px}
.pt-legend span{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono';font-size:11.5px;color:var(--text-2)}
.pt-legend i,.pt-house,.pt-car,.pt-inst{display:inline-block}
.pt-legend i{width:10px;height:10px;border-radius:2px}
.pt-legend .pt-house{background:var(--amber)}
.pt-legend .pt-car{background:var(--cyan)}
.pt-legend .pt-inst{background:var(--purple)}
.pt-dow{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:6px}
.pt-dow span{font-family:'JetBrains Mono';font-size:11px;color:var(--text-dim);text-align:center}
.pt-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.pt-cell{aspect-ratio:auto;min-height:74px;max-height:94px;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;min-width:0;overflow:hidden}
.pt-cell.empty{background:transparent;border:none}
.pt-cell.today{border:1.5px solid var(--cyan)}
.pt-cell-d{font-family:'JetBrains Mono';font-size:12px;color:var(--text-2)}
.pt-cell.today .pt-cell-d{color:var(--cyan-bright);font-weight:700}
.pt-cell-dots{display:flex;flex-wrap:wrap;gap:2px;flex:1;align-content:flex-start}
.pt-cell-dot{width:9px;height:9px;border-radius:50%}
.pt-cell-dot.pt-house{background:var(--amber)}
.pt-cell-dot.pt-car{background:var(--cyan)}
.pt-cell-dot.pt-inst{background:var(--purple)}
.pt-cell-dot.paid{opacity:.4}
.pt-cell-amt{font-family:'JetBrains Mono';font-size:11px;font-weight:600;color:var(--text-2);line-height:1.1}
.pt-grid-note{font-family:'Outfit';font-size:9.5px;color:var(--text-faint);text-align:center;margin-top:12px}
@media(min-width:900px){
  .pt-body-2up{display:grid;grid-template-columns:1.1fr 1fr;gap:16px;align-items:start}
}
@media(max-width:520px){
  .pt-cycle-v{font-size:20px}
  .pt-cell{min-height:50px;max-height:60px;padding:4px 5px}
  .pt-cell-d{font-size:9.5px}
  .pt-cell-dot{width:7px;height:7px}
  .pt-cell-amt{display:none}
  .pt-legend span{font-size:9.5px}
  .pt-toggle button{padding:6px 9px;font-size:11px}
}
/* ---- LOAN HEALTH BADGE ---- */
.ln-health{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:11px;font-family:'JetBrains Mono';font-size:10.5px;font-weight:600;letter-spacing:0.3px;border:1px solid;background:transparent;white-space:nowrap}
.ln-health svg{width:11px;height:11px}
.ln-health.on-track{background:rgba(93,211,158,0.1);border-color:rgba(93,211,158,0.4);color:var(--teal-2)}
.ln-health.ahead{background:rgba(94,234,212,0.1);border-color:rgba(94,234,212,0.4);color:var(--teal)}
.ln-health.behind{background:rgba(255,149,84,0.1);border-color:rgba(255,149,84,0.4);color:var(--orange)}
/* hero meta needs flex layout to fit the badge */
.ln-hero-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
/* ---- RECONCILIATION CARD ---- */
.ln-recon{position:relative;overflow:hidden;background:linear-gradient(135deg,rgba(255,149,84,0.05),rgba(245,193,75,0.02)),linear-gradient(135deg,var(--surface-2),var(--bg-2));border:1px solid rgba(255,149,84,0.25);border-radius:11px;padding:14px 16px;margin:14px 0}
.ln-recon.ahead{background:linear-gradient(135deg,rgba(94,234,212,0.05),rgba(34,211,238,0.02)),linear-gradient(135deg,var(--surface-2),var(--bg-2));border-color:rgba(94,234,212,0.25)}
.ln-recon::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--orange),var(--amber))}
.ln-recon.ahead::before{background:linear-gradient(180deg,var(--teal),var(--cyan))}
.ln-recon-h{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.ln-recon-ic{width:26px;height:26px;border-radius:7px;background:rgba(255,149,84,0.13);border:1px solid rgba(255,149,84,0.3);color:var(--orange);display:grid;place-items:center;flex-shrink:0}
.ln-recon.ahead .ln-recon-ic{background:rgba(94,234,212,0.13);border-color:rgba(94,234,212,0.3);color:var(--teal)}
.ln-recon-ic svg{width:13px;height:13px}
.ln-recon-h-body{flex:1;min-width:0}
.ln-recon-title{font-family:'Chakra Petch';font-size:13.5px;font-weight:600;color:var(--text);line-height:1.4}
.ln-recon-title b{color:var(--orange)}
.ln-recon.ahead .ln-recon-title b{color:var(--teal)}
.ln-recon-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:3px}
.ln-recon-body p{color:var(--text-bright);font-size:12px;line-height:1.55;margin-top:8px}
.ln-recon-body p b{color:var(--text-2)}
.ln-recon-reasons{margin-top:10px;padding:10px 12px;background:var(--dsurf-23);border-radius:7px;border:1px solid var(--border)}
.ln-recon-reasons-h{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px}
.ln-recon-reasons ul{list-style:none;padding:0;margin:0}
.ln-recon-reasons li{color:var(--text-2);font-size:11.5px;line-height:1.55;padding:3px 0 3px 14px;position:relative}
.ln-recon-reasons li::before{content:'\\21b3';position:absolute;left:0;color:var(--text-faint);font-family:'JetBrains Mono'}
.ln-recon-reasons li b{font-family:'JetBrains Mono';color:var(--amber)}
.ln-recon-foot{margin-top:11px;padding-top:9px;border-top:1px dashed rgba(255,149,84,0.2);font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);line-height:1.55}
.ln-recon.ahead .ln-recon-foot{border-top-color:rgba(94,234,212,0.2)}
.ln-recon-foot b{color:var(--text-bright)}
/* Privacy: blur the monetary values in reconciliation card */
body.privacy-on .ln-recon-title b,
body.privacy-on .ln-recon-sub{filter:blur(7px);transition:filter .35s cubic-bezier(.22,.61,.36,1)}
body.privacy-on .ln-recon:hover .ln-recon-title b,
body.privacy-on .ln-recon:hover .ln-recon-sub{filter:none;transition:filter .12s ease-out}
.fp-loans-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--orange) 0%,var(--teal) 100%)}
.fp-loans-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.fp-loans-title-row{display:flex;align-items:center;gap:9px}
.fp-loans-title-row .ic{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,rgba(255,149,84,0.15),rgba(94,234,212,0.1));border:1px solid rgba(255,149,84,0.3);color:var(--orange);display:grid;place-items:center}
.fp-loans-title-row .ic svg{width:14px;height:14px}
.fp-loans-title{font-family:'Chakra Petch';font-size:15px;font-weight:600;color:var(--text)}
.fp-loans-pill{font-family:'JetBrains Mono';font-size:10px;background:rgba(167,139,250,0.12);border:1px solid var(--glow-purple-2);color:var(--purple-light);padding:3px 9px;border-radius:12px}
.fp-loans-totals{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:12px 14px;background:var(--dsurf-15);border:1px solid var(--border);border-radius:10px;margin-bottom:14px}
.fp-loans-total-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:4px}
.fp-loans-total-val{font-family:'JetBrains Mono';font-size:20px;font-weight:700;color:var(--red)}
.fp-loans-total-val.emi{color:var(--cyan-bright)}
.fp-loans-total-sub{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);margin-top:3px}
.fp-loans-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.fp-loans-mini{background:var(--dsurf-14);border:1px solid var(--border);border-radius:10px;padding:13px;cursor:pointer;transition:.15s}
.fp-loans-mini:hover{border-color:rgba(94,234,212,0.4);background:rgba(94,234,212,0.04);transform:translateY(-1px)}
.fp-loans-mini-h{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.fp-loans-mini-ic{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;flex-shrink:0}
.fp-loans-mini-ic.car{background:rgba(245,193,75,0.13);border:1px solid #f5c14b44;color:var(--amber)}
.fp-loans-mini-ic.house{background:rgba(34,211,238,0.13);border:1px solid var(--glow-cyan-2);color:var(--cyan-bright)}
.fp-loans-mini-ic svg{width:11px;height:11px}
.fp-loans-mini-name{font-family:'Chakra Petch';font-size:12px;font-weight:600;color:var(--text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-loans-mini-arrow{color:var(--text-faint);font-size:13px}
.fp-loans-mini-balrow{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.fp-loans-mini-out{font-family:'JetBrains Mono';font-size:13px;font-weight:700;color:var(--red)}
.fp-loans-mini-pct{font-family:'JetBrains Mono';font-size:10px;color:var(--teal)}
.fp-loans-mini-bar{height:4px;background:var(--border-3);border-radius:2px;overflow:hidden;margin-bottom:6px}
.fp-loans-mini-bar-fill{height:100%;background:linear-gradient(90deg,var(--orange),var(--teal));border-radius:2px;transition:width .4s ease}
.fp-loans-mini-meta{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.fp-loans-mini-meta b{color:var(--text-bright)}
.fp-loans-foot{margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim)}
.fp-loans-foot strong{color:var(--teal-2)}
.fp-loans-empty{padding:20px;text-align:center;color:var(--text-faint);font-family:'JetBrains Mono';font-size:11px}
@media(max-width:600px){.fp-loans-totals{grid-template-columns:1fr;gap:12px}}
/* Privacy blur for the new card */
body.privacy-on .fp-loans-total-val,
body.privacy-on .fp-loans-total-sub,
body.privacy-on .fp-loans-mini-out{filter:blur(7px);transition:filter .35s cubic-bezier(.22,.61,.36,1)}
body.privacy-on .fp-loans-card:hover .fp-loans-total-val,
body.privacy-on .fp-loans-card:hover .fp-loans-total-sub,
body.privacy-on .fp-loans-mini:hover .fp-loans-mini-out{filter:none;transition:filter .12s ease-out}
/* ---- FORMULA EXPLAINER POPOVER ---- */
.ln-fx-info{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:rgba(34,211,238,0.1);border:1px solid var(--glow-cyan-2);color:var(--cyan-bright);cursor:pointer;padding:0;transition:.15s;margin-left:6px;vertical-align:middle;flex-shrink:0}
.ln-fx-info:hover,.ln-fx-info.active{background:rgba(34,211,238,0.25);border-color:var(--cyan);box-shadow:0 0 10px rgba(34,211,238,0.4)}
.ln-fx-info svg{width:10px;height:10px}
.ln-fx-info.amber{background:rgba(245,193,75,0.1);border-color:#f5c14b44;color:var(--amber)}
.ln-fx-info.amber:hover{background:rgba(245,193,75,0.25);border-color:var(--amber);box-shadow:0 0 10px rgba(245,193,75,0.4)}
.ln-fx-overlay{position:fixed;inset:0;background:var(--dsurf-24);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;animation:fxFade .18s ease}
@keyframes fxFade{from{opacity:0}to{opacity:1}}
.ln-fx-pop{background:linear-gradient(160deg,var(--dsurf-19),var(--dsurf-12));border:1px solid var(--glow-cyan);border-radius:13px;box-shadow:0 24px 70px rgba(0,0,0,0.7),0 0 32px rgba(34,211,238,0.15);width:100%;max-width:460px;overflow:hidden;animation:fxIn .22s cubic-bezier(.2,.8,.2,1)}
.ln-fx-pop.amber{border-color:#f5c14b55;box-shadow:0 24px 70px rgba(0,0,0,0.7),0 0 32px rgba(245,193,75,0.15)}
@keyframes fxIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.ln-fx-h{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.ln-fx-h-ic{width:28px;height:28px;border-radius:7px;background:rgba(34,211,238,0.15);border:1px solid var(--glow-cyan);color:var(--cyan-bright);display:grid;place-items:center;flex-shrink:0}
.ln-fx-h-ic.amber{background:rgba(245,193,75,0.15);border-color:#f5c14b55;color:var(--amber)}
.ln-fx-h-ic svg{width:14px;height:14px}
.ln-fx-h-title{flex:1;font-family:'Chakra Petch';font-size:14px;color:var(--text);font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ln-fx-h-title .badge{font-family:'JetBrains Mono';font-size:9.5px;background:rgba(94,234,212,0.12);border:1px solid #5eead444;color:var(--teal);padding:2px 7px;border-radius:9px;font-weight:500}
.ln-fx-h-title .badge.amber{background:rgba(245,193,75,0.12);border-color:#f5c14b44;color:var(--amber)}
.ln-fx-h-x{background:none;border:none;color:var(--text-faint);cursor:pointer;padding:4px;transition:.15s}
.ln-fx-h-x:hover{color:var(--red)}
.ln-fx-h-x svg{width:14px;height:14px}
.ln-fx-body{padding:14px 18px;max-height:70vh;overflow-y:auto}
.ln-fx-section{margin-bottom:16px}
.ln-fx-section:last-child{margin-bottom:0}
.ln-fx-section-h{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px;display:flex;align-items:center;gap:6px}
.ln-fx-section-h .dot{width:5px;height:5px;border-radius:50%;background:var(--cyan-bright)}
.ln-fx-section-h.amber .dot{background:var(--amber)}
.ln-fx-section-h.purple .dot{background:var(--purple-light)}
.ln-fx-section-h.teal .dot{background:var(--teal)}
.ln-fx-section p{color:var(--text-bright);font-size:12.5px;line-height:1.55}
.ln-fx-section p b{color:var(--text-2);font-weight:600}
.ln-fx-section p code{font-family:'JetBrains Mono';background:#0e1424;padding:1px 5px;border-radius:3px;color:#5dcef0;font-size:11px}
.ln-fx-formula-block{background:rgba(34,211,238,0.06);border:1px solid #22d3ee2a;border-radius:7px;padding:9px 12px;font-family:'JetBrains Mono';font-size:12px;color:var(--cyan-bright);font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.ln-fx-formula-block.amber{background:rgba(245,193,75,0.06);border-color:#f5c14b2a;color:var(--amber)}
.ln-fx-formula-block .arrow{color:var(--text-dim);margin:0 4px}
.ln-fx-formula-block b{color:var(--teal);font-weight:700;font-size:13px}
.ln-fx-vars{background:var(--dsurf-16);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:grid;gap:7px}
.ln-fx-var{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;font-family:'JetBrains Mono';font-size:11.5px}
.ln-fx-var .v-sym{color:#5dcef0;font-weight:600}
.ln-fx-var .v-name{color:var(--text-dim)}
.ln-fx-var .v-val{color:var(--text-2);font-weight:500}
@media (max-width:600px){.ln-fx-formula-block{flex-direction:column;align-items:flex-start;gap:4px}}
.ln-edit-btn-hdr:hover{background:rgba(155,89,255,0.25);border-color:var(--glow-purple-5)}
@media (max-width:720px){.ln-form-row.two,.ln-form-row.three,.ln-locked-grid{grid-template-columns:1fr}.ln-modal{max-height:calc(100dvh - 84px)}.ln-modal-overlay{align-items:center;padding:calc(54px + env(safe-area-inset-top)) 14px calc(64px + env(safe-area-inset-bottom))}}
.ln-modal-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:14px;padding-top:13px;border-top:1px solid var(--border)}
.ln-btn-c{background:transparent;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11.5px;font-weight:500;padding:8px 14px;border-radius:7px;cursor:pointer;transition:.15s}
.ln-btn-c:hover{border-color:#3a4a6a;color:var(--text-2)}
.ln-btn-s{background:linear-gradient(135deg,var(--purple),var(--purple-deep));border:none;color:#fff;font-family:'Outfit';font-size:11.5px;font-weight:600;padding:8px 16px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:.15s;box-shadow:0 4px 14px rgba(167,139,250,0.3)}
.ln-btn-s:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(167,139,250,0.4)}
.ln-btn-s:disabled{opacity:.6;cursor:wait}

@media (max-width: 880px) {
  .ln-main{padding:14px 16px;gap:10px}
  .ln-hero{grid-template-columns:1fr;padding:12px}
  .ln-np{grid-template-columns:auto 1fr;gap:10px;padding:11px 13px}
  .ln-np-right{grid-column:1/-1;flex-direction:row;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px dashed var(--border);margin-top:2px}
  .ln-results{grid-template-columns:1fr;gap:7px}
  .ln-res-val{font-size:17px}
  .ln-photo{align-self:stretch}
  .ln-hero-name{font-size:22px;margin-bottom:11px}
  .ln-bal-val{font-size:22px}
  .ln-hero-balance{grid-template-columns:1fr;gap:9px}
  .ln-hero::before{display:none}
  .ln-hero{padding:16px 18px}
  .ln-stats{grid-template-columns:1fr 1fr;gap:9px}
  .ln-stat-val{font-size:16px}
  .ln-card{padding:12px 13px}
  .ln-card-title{font-size:12.5px}
  .ln-amort-chart{height:90px;padding:8px 0}
  .ln-calc-row.formula{flex-direction:column;align-items:stretch;gap:5px}
  .ln-calc-row.formula > span:first-child{display:flex;align-items:center;gap:5px}
  .ln-calc-row.formula > span:last-child{text-align:left;padding-left:8px;font-size:11px}
  .ln-calc-row{font-size:11.5px}
}

/* Year picker compact widget */
.fp-year-picker{display:inline-flex;align-items:center;gap:1px;background:var(--bg-3);border:1px solid var(--border);border-radius:9px;padding:2px}
.fp-yp-arrow{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:7px 8px;border-radius:7px;display:grid;place-items:center;transition:.15s}
.fp-yp-arrow:hover:not(:disabled){color:var(--cyan);background:#22d3ee10}
.fp-yp-arrow:disabled{opacity:.25;cursor:not-allowed}
.fp-yp-current{display:flex;align-items:center;justify-content:center;background:var(--cyan);color:var(--bg);font-family:'JetBrains Mono';font-size:12px;font-weight:700;padding:7px 14px;border-radius:7px;letter-spacing:.5px;box-shadow:0 0 14px var(--glow-cyan);min-width:78px;user-select:none}

/* Floating Action Button */
.fp-fab{position:fixed;bottom:28px;right:28px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--cyan),#0891b2);border:none;color:var(--bg);cursor:pointer;display:grid;place-items:center;box-shadow:0 0 26px var(--glow-cyan-5),0 12px 32px -8px #000;transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .2s;z-index:9996}
.fp-fab:hover{transform:scale(1.08);box-shadow:0 0 36px #22d3eeaa,0 16px 40px -8px #000}
.fp-fab.open{transform:rotate(135deg);background:linear-gradient(135deg,var(--purple),var(--purple-deep));box-shadow:0 0 26px var(--glow-purple-5),0 12px 32px -8px #000}
.fp-fab svg{stroke-width:2.5}
.fp-entry-bar{display:none}
@media(max-width:760px){.fp-fab{bottom:18px;right:18px;width:52px;height:52px}}

/* FAB Add Item Modal */
.fp-fab-modal-bg{position:fixed;inset:0;background:var(--dsurf-22);backdrop-filter:blur(8px);display:grid;place-items:center;z-index:9995;padding:20px;animation:fadeIn .2s ease-out}
.fp-fab-modal{width:100%;max-width:480px;background:linear-gradient(160deg,var(--surface),var(--bg-3));border:1px solid var(--border);border-radius:14px;animation:popUp .25s cubic-bezier(.2,.8,.2,1);box-shadow:0 0 50px #00000099}
@keyframes popUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.fp-fab-head{display:flex;align-items:center;gap:9px;padding:14px 18px;border-bottom:1px solid var(--border-soft)}
.fp-fab-head h3{margin:0;font-family:'Chakra Petch';font-size:13.5px;color:var(--text);font-weight:600;letter-spacing:.4px;flex:1;display:flex;align-items:center;gap:7px}
.fp-fab-head h3 svg{color:var(--cyan)}
.fp-fab-body{padding:16px 18px;display:flex;flex-direction:column;gap:9px}
.fp-line{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0}
.fp-line-name{font-size:13px;color:var(--text-2);line-height:1.3;flex:1}
.fp-line-name em{display:block;font-style:normal;font-size:10.5px;color:var(--text-faint);font-family:'JetBrains Mono';margin-top:1px}
.fp-input{display:flex;align-items:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;padding:0 10px;transition:.16s;min-width:120px;position:relative}
.fp-input:focus-within{border-color:var(--cyan);box-shadow:0 0 0 3px var(--glow-cyan-3)}
.fp-input.saving{border-color:var(--amber-2)}
.fp-input.saved{border-color:var(--green)}
.fp-input span{font-family:'JetBrains Mono';font-size:11px;color:var(--text-faint)}
.fp-input input{background:none;border:none;outline:none;color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:13.5px;width:84px;text-align:right;padding:9px 0}
.fp-input input::placeholder{color:#33415c}
.fp-add{display:grid;place-items:center;min-height:80px;border-style:dashed}
.fp-add-btn{display:flex;align-items:center;gap:8px;background:none;border:none;color:var(--text-dim);font-family:'Outfit';font-size:13.5px;cursor:pointer;padding:14px;transition:.16s}
.fp-add-btn:hover{color:var(--cyan)}
.fp-add-form{width:100%;padding:6px;display:flex;flex-direction:column;gap:5px}
.fp-add-form select,.fp-add-form input{background:var(--bg-2);border:1px solid var(--border);border-radius:9px;color:var(--text);font-family:'Outfit';font-size:13px;padding:10px 11px;outline:none;margin-bottom:4px}
.fp-add-form input:focus,.fp-add-form select:focus{border-color:var(--cyan)}
.fp-add-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:1px;text-transform:uppercase;font-weight:500;margin-top:4px}
.fp-add-label:first-child{margin-top:0}
.fp-add-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.fp-add-actions button{font-family:'Outfit';font-size:12.5px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border);display:flex;align-items:center;gap:6px}
.fp-add-actions .ghost{background:none;color:var(--text-dim)}
.fp-add-actions .solid{background:var(--cyan);color:var(--on-accent);border-color:var(--cyan);font-weight:600}
.fp-foot{display:flex;justify-content:space-between;padding:22px 28px 6px;font-size:11px;color:var(--border-4);font-family:'JetBrains Mono';flex-wrap:wrap;gap:8px}
.fp-foot-credit{display:inline-flex;align-items:center;gap:7px}
.fp-cf-logo{height:14px;width:auto;opacity:.85;transition:opacity .15s}
.fp-cf-logo:hover{opacity:1}
.fp-err{max-width:520px;margin:80px auto;padding:30px;text-align:center}
.fp-err h2{font-family:'Chakra Petch';color:var(--pink);margin:0 0 10px}
.fp-err pre{background:var(--bg-2);border:1px solid #2d1620;border-radius:8px;padding:14px;color:var(--text-soft);font-size:11px;text-align:left;overflow-x:auto}
.fp-err button{margin-top:12px;background:var(--cyan);color:var(--on-accent);border:0;padding:9px 20px;border-radius:8px;font-family:'Outfit';font-weight:600;cursor:pointer}
.reveal{animation:rise .55s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media(max-width:880px){.fp-kpis{grid-template-columns:repeat(2,1fr)}.fp-charts{grid-template-columns:1fr}.fp-cat-row{grid-template-columns:26px 1fr 0 50px 100px}.fp-cat-bar{display:none}.fp-main{padding:14px}.fp-top{padding:16px}.fp-insights{grid-template-columns:repeat(2,1fr)}.fp-dashboard-row2{grid-template-columns:1fr}.fp-yoy-row{grid-template-columns:1fr 60px;grid-template-areas:"cat pct" "bar bar";gap:5px}.fp-yoy-cat{grid-area:cat}.fp-yoy-bar-wrap{grid-area:bar}.fp-yoy-pct{grid-area:pct;justify-content:flex-end}}

/* ===== Spend by Category — narrow mobile ===== */
@media(max-width:600px){
  .fp-cat-row{grid-template-columns:24px 1fr auto;grid-template-areas:"ic name amt" "ic name pct";column-gap:10px;row-gap:0;padding:6px 0;align-items:center}
  .fp-cat-ic{grid-area:ic}
  .fp-cat-name{grid-area:name;font-size:12.5px;line-height:1.3}
  .fp-cat-bar{display:none}
  .fp-cat-amt{grid-area:amt;font-size:12.5px;white-space:nowrap;align-self:end}
  .fp-cat-pct{grid-area:pct;font-size:10.5px;text-align:right;align-self:start}
}

/* ===== MOBILE NAV — 600px and below ===== */
@media(max-width:600px){
  .fp-top{padding:14px 14px 12px;gap:10px}
  /* On mobile, the parent .fp-sticky-top creates a stacking context (from .fp-root>* rule).
     Clear its z-index so the position:fixed .fp-nav inside can layer above .fp-main. */
  .fp-sticky-top{z-index:auto!important;isolation:auto}
  .fp-top-right{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%}
  .fp-tr-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;width:100%}
  .fp-tr-row1{justify-content:flex-end}
  .fp-tr-row2{justify-content:flex-end}
  .fp-top-right .fp-privacy{grid-column:1 / -1;justify-self:end}
  .fp-datetime{font-size:10.5px;padding:6px 11px;gap:7px}
  .fp-datetime .fp-date{font-size:10.5px}
  .fp-datetime .fp-time{font-size:10.5px}
  .fp-control{flex-direction:column;align-items:stretch;padding:14px 14px 4px;gap:10px}
  .fp-nav{display:flex;gap:2px;padding:3px;width:100%;justify-content:space-between}
  .fp-nav button{flex:1;justify-content:center;padding:8px 3px;font-size:10.5px;gap:3px;white-space:nowrap;min-width:0;overflow:hidden;letter-spacing:0}
  .fp-nav button svg{flex-shrink:0;width:12px;height:12px}
  .fp-tab-short{display:inline}
  .fp-tab-long{display:none}
  .fp-years{order:2;align-self:flex-start;flex-wrap:nowrap;align-items:center}
  .fp-years button{padding:6px 11px;font-size:11px}
  .fp-fy-new{margin-left:auto;font-size:10.5px;padding:6px 10px}

  /* ===== BOTTOM NAV (mobile only) ===== */
  /* Move .fp-nav out of .fp-control and pin to bottom of viewport */
  .fp-nav{position:fixed!important;bottom:0;left:0;right:0;z-index:100;background:var(--bg)!important;border-top:1px solid var(--border);border-radius:0!important;padding:6px 4px calc(8px + env(safe-area-inset-bottom))!important;margin:0;width:auto;gap:0;box-shadow:0 -4px 16px -8px #000}
  .fp-nav button{position:relative;flex:1;flex-direction:column!important;padding:6px 2px 4px!important;gap:3px;background:transparent!important;border:none!important;border-radius:0!important;font-size:9.5px!important;color:var(--text-faint)!important;box-shadow:none!important;min-width:0;letter-spacing:0.2px;overflow:visible!important;align-items:center!important;justify-content:flex-start!important}
  .fp-nav button svg{width:18px!important;height:18px!important;color:var(--text-faint);z-index:1;position:relative}
  .fp-nav button.on{background:transparent!important;color:var(--cyan)!important;box-shadow:none!important}
  .fp-nav button.on svg{color:var(--cyan)}
  .fp-nav button.on::before{content:'';position:absolute;top:2px;left:50%;transform:translateX(-50%);width:42px;height:26px;border-radius:13px;background:linear-gradient(135deg,var(--glow-cyan-3),#06b6d422);box-shadow:inset 0 0 0 1px var(--glow-cyan);pointer-events:none;z-index:0}
  .fp-tab-short{display:inline!important;font-size:9.5px;font-weight:500;position:relative;z-index:1}
  .fp-tab-long{display:none!important}
  /* Kill desktop proximity-glow + hover effects on the bottom nav */
  .fp-nav button.lg-fx::after{display:none!important}
  .fp-nav button.lg-fx:not(.on){box-shadow:none!important}
  .fp-nav button.lg-fx.on{box-shadow:none!important}

  /* Hide arrow-style year picker + Start FY27, show segmented pill */
  .fp-years{display:none!important}
  .fp-years-mobile{display:flex}

  /* Push content above bottom nav (~70px nav + safe area) */
  .fp-root{padding-bottom:calc(80px + env(safe-area-inset-bottom))!important}

  /* Entry tab: swap round FAB for a full-width New Entry bar (sits above bottom nav) */
  .fp-fab{display:none!important}
  .fp-entry-bar{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:14px;padding:15px;border:none;border-radius:13px;background:linear-gradient(135deg,var(--cyan),#0891b2);color:var(--on-accent);font-family:'Outfit';font-size:14px;font-weight:700;letter-spacing:0.4px;cursor:pointer;box-shadow:0 0 22px var(--glow-cyan-2),0 8px 24px -8px #000;transition:transform .15s,box-shadow .2s}
  .fp-entry-bar:active{transform:scale(0.98)}
  .fp-entry-bar svg{stroke-width:2.6}
}

/* ===== EXTRA NARROW — icon-only nav for tiny phones ===== */
@media(max-width:500px){
  /* Bottom-nav: every tab equal width, icon + short label always visible.
     (Overrides legacy top-nav behavior that hid labels + expanded active tab.) */
  .fp-nav button{padding:6px 2px 4px!important;gap:3px!important;flex:1!important;justify-content:flex-start!important}
  .fp-nav button:not(.on){padding:6px 2px 4px!important}
  .fp-nav button.on{padding:6px 2px 4px!important;gap:3px!important;flex:1!important;justify-content:flex-start!important}
  .fp-nav button:not(.on) .fp-tab-short{display:inline!important}
  .fp-nav button:not(.on) .fp-tab-long{display:none!important}
  .fp-nav button.on svg{margin-right:0!important}
  .fp-nav button svg{width:18px!important;height:18px!important}
  /* Shrink KPI value so big numbers (e.g. RM 153,360) stay on one line in 2-col grid */
  .fp-kpi-val{font-size:22px}
  .fp-kpi-val .fp-kpi-rm{font-size:14px;margin-right:4px}
}
@media(max-width:380px){
  .fp-nav button{font-size:9px!important}
  .fp-nav button.on{font-size:9px!important;padding:6px 2px 4px!important}
  .fp-nav button svg{width:17px!important;height:17px!important}
  .fp-kpi-val{font-size:20px;letter-spacing:-.6px}
  .fp-kpi-val .fp-kpi-rm{font-size:13px;margin-right:3px}
  .fp-datetime{padding:5px 10px;gap:6px}
  .fp-datetime .fp-date{font-size:10px}
  .fp-datetime .fp-time{font-size:10px}
}

/* ===== INSTALLMENTS TRACKER ===== */
.ct-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.ct-filters{margin-top:16px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.ct-chips{display:flex;gap:5px;flex-wrap:wrap}
.ct-chip{display:flex;align-items:center;gap:8px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:12.5px;padding:8px 14px;border-radius:9px;cursor:pointer;transition:.15s}
.ct-chip.on{background:linear-gradient(135deg,#7c3aed33,var(--glow-purple-4));border-color:var(--purple);color:var(--purple-light)}
.ct-chip-n{font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-faint);background:#ffffff08;padding:1px 6px;border-radius:5px}
.ct-chip.on .ct-chip-n{color:var(--purple);background:var(--glow-purple-4)}
.ct-buyer{display:flex;gap:4px;background:var(--bg-3);border:1px solid var(--border);padding:3px;border-radius:9px}
.ct-buyer-btn{background:none;border:none;color:var(--text-dim);font-family:'Outfit';font-size:12px;padding:6px 12px;border-radius:7px;cursor:pointer;transition:.15s}
.ct-buyer-btn.on{background:var(--border);color:var(--text-2)}
.ct-search{display:flex;align-items:center;gap:8px;background:var(--bg-2);border:1px solid var(--border);padding:0 12px;border-radius:9px;transition:.15s;min-width:180px;flex:1;max-width:260px}
.ct-search:focus-within{border-color:var(--purple)}
.ct-search svg{color:var(--text-faint)}
.ct-search input{background:none;border:none;outline:none;color:var(--text);font-family:'Outfit';font-size:12.5px;padding:9px 0;width:100%}
.ct-search input::placeholder{color:#475569}
.ct-cta{display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,var(--purple),var(--purple-deep));color:#fff;border:none;font-family:'Outfit';font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;cursor:pointer;box-shadow:0 0 14px var(--glow-purple);transition:.15s;white-space:nowrap}
.ct-cta:hover{transform:translateY(-1px);box-shadow:0 0 20px var(--glow-purple-5)}

.ct-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:16px;align-items:start}

/* Installments tab — sectioned view */
.ct-section-head{display:flex;align-items:center;gap:9px;margin:22px 0 10px 4px;font-family:'Chakra Petch';font-size:13px;font-weight:600;color:var(--text-2);letter-spacing:.5px}
.ct-section-head svg{color:var(--cyan)}
.ct-section-head + .ct-cards{margin-top:0}
.ct-section-count{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);background:var(--bg-2);border:1px solid var(--border);padding:2px 8px;border-radius:20px;font-weight:500;letter-spacing:.3px}
.ct-section-divider{margin:26px 4px 0;height:1px;background:linear-gradient(90deg, transparent, var(--border) 20%, var(--border-2) 50%, var(--border) 80%, transparent);position:relative}
.ct-section-divider::before{content:'';position:absolute;left:50%;top:-3px;width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,var(--cyan),var(--purple));box-shadow:0 0 12px var(--glow-purple-3);transform:translateX(-50%)}
.ct-card{padding:16px 17px;cursor:pointer;transition:.18s;position:relative;overflow:hidden}
.ct-card:hover{transform:translateY(-2px);border-color:var(--border-2);box-shadow:0 1px 0 var(--grid) inset,0 28px 70px -30px #000}
.ct-card.paid{opacity:.65}
.ct-card.paid:hover{opacity:1}
.ct-card.overdue{border-color:#7c1d3680}
.ct-card-head{display:flex;align-items:flex-start;gap:11px;margin-bottom:13px}
.ct-card-ic{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;flex-shrink:0}
.ct-card-name{flex:1;min-width:0}
.ct-card-title{font-family:'Chakra Petch';font-size:14px;font-weight:600;color:var(--text);letter-spacing:.3px}
.ct-card-meta{display:flex;gap:6px;margin-top:3px;flex-wrap:wrap}
.ct-cat{font-size:10.5px;color:var(--text-muted);font-family:'JetBrains Mono'}
.ct-buyer-tag{font-size:10px;color:var(--text-dim);background:#ffffff08;border:1px solid var(--grid);padding:1px 6px;border-radius:4px;font-family:'JetBrains Mono'}
.ct-status{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-family:'JetBrains Mono';text-transform:uppercase;padding:3px 8px;border-radius:5px;letter-spacing:.5px;font-weight:500;height:fit-content}
.ct-status.pos{color:var(--teal);background:#34d39915;border:1px solid var(--glow-green-3)}
.ct-status.neg{color:#fda4af;background:#fb718515;border:1px solid #fb718533}
.ct-status.active{color:var(--purple-light);background:#a78bfa15;border:1px solid #a78bfa33}
.ct-money-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:11px 0;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);margin-bottom:13px}
.ct-money-l{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.ct-money-v{font-family:'JetBrains Mono';font-size:13px;color:var(--text-2);font-weight:500}
.ct-progress{margin-bottom:13px}
.ct-progress-bar{height:6px;background:var(--surface-3);border-radius:4px;overflow:hidden;margin-bottom:7px}
.ct-progress-fill{height:100%;border-radius:4px;transition:width .9s cubic-bezier(.2,.8,.2,1)}
.ct-progress-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono'}
.ct-progress-meta .pos{color:var(--teal)}.ct-progress-meta .neg{color:var(--pink-light)}.ct-progress-meta .active{color:var(--purple-light)}
.ct-bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}

/* Mark-Paid button row */
.ct-pay-row{display:flex;gap:6px;margin-top:11px;padding-top:11px;border-top:1px dashed var(--border)}
.ct-pay-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:linear-gradient(135deg,#34d39915,#22d3ee15);border:1px solid var(--glow-green);color:var(--teal);font-family:'JetBrains Mono';font-size:11.5px;font-weight:600;padding:8px 12px;border-radius:8px;cursor:pointer;transition:.15s;letter-spacing:.2px}
.ct-pay-btn:hover{border-color:var(--green);background:linear-gradient(135deg,#34d39925,#22d3ee20);box-shadow:0 0 14px var(--glow-green-2);transform:translateY(-1px)}
.ct-pay-btn:active{transform:translateY(0)}
.ct-pay-undo{display:inline-flex;align-items:center;gap:4px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:10.5px;padding:8px 11px;border-radius:8px;cursor:pointer;transition:.15s}
.ct-pay-undo:hover{border-color:var(--glow-pink);color:var(--pink-light);background:#fb718510}

/* Months-behind warning */
.ct-behind{display:flex;align-items:center;gap:5px;margin-top:6px;font-family:'JetBrains Mono';font-size:10px;color:var(--amber);font-weight:500}
.ct-behind svg{flex-shrink:0}
.ct-big{font-family:'JetBrains Mono';font-size:19px;font-weight:700;letter-spacing:-.3px}
.ct-big.pos{color:var(--teal)}.ct-big.neg{color:var(--pink-light)}.ct-big.active{color:var(--cyan-bright)}
.ct-next{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono'}
.ct-detail{margin-top:14px;padding-top:13px;border-top:1px solid var(--border-soft);animation:slide .3s ease-out}
@keyframes slide{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.ct-detail-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.ct-icon-btn{background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;padding:5px 7px;border-radius:6px;display:grid;place-items:center;transition:.15s}
.ct-icon-btn:hover{color:var(--text-2);border-color:var(--border-2);background:#ffffff05}
.ct-icon-btn.danger:hover{color:var(--pink-light);border-color:#7c1d36;background:#fb718510}
.ct-timeline{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:10px}
.ct-cell{width:16px;height:16px;border-radius:3px;background:var(--surface-3);border:1px solid var(--border);display:grid;place-items:center;color:#fff;transition:.15s}
.ct-cell.current{border:1px solid var(--purple);background:var(--glow-purple-4);animation:pulse 1.6s infinite}
.ct-detail-meta{display:flex;gap:8px;font-size:10.5px;color:var(--text-muted);font-family:'JetBrains Mono';flex-wrap:wrap}
.ct-empty{padding:40px;text-align:center;color:var(--text-muted);font-size:13.5px;grid-column:1/-1}

/* ===== MODAL ===== */
.ct-modal-bg{position:fixed;inset:0;background:var(--dsurf-22);backdrop-filter:blur(8px);display:grid;place-items:center;z-index:50;padding:20px;animation:fadeIn .2s ease-out}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.ct-modal{width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;animation:rise .3s cubic-bezier(.2,.8,.2,1);overflow:hidden}
.ct-modal-head{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--border-soft)}
.ct-modal-head h3{margin:0;font-family:'Chakra Petch';font-size:16px;font-weight:600;color:var(--text);letter-spacing:.5px}
.ct-modal-body{padding:18px 22px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;overflow-x:hidden}
.ct-modal-foot{padding:14px 22px;border-top:1px solid var(--border-soft);display:flex;justify-content:flex-end;gap:8px}
.ct-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.ct-field label{font-size:10.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;font-weight:500}
.ct-field input,.ct-field select{background:var(--bg-2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Outfit';font-size:13px;padding:10px 11px;outline:none;transition:.15s;width:100%;min-width:0;box-sizing:border-box}
.ct-field input:focus,.ct-field select:focus{border-color:var(--purple);box-shadow:0 0 0 3px var(--glow-purple-4)}
.ct-row-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ct-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.ct-icon-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(34px, 1fr));gap:5px}
.ct-icon-pick{background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);aspect-ratio:1;border-radius:7px;cursor:pointer;display:grid;place-items:center;transition:.15s;min-width:0}
.ct-icon-pick:hover{border-color:var(--border-2);color:var(--text-2)}
.ct-icon-pick.on{background:#a78bfa20;border-color:var(--purple);color:var(--purple-light)}
.ct-color-grid{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 0}
.ct-color-pick{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:.15s}
.ct-color-pick:hover{transform:scale(1.12)}
.ct-color-pick.on{border-color:#fff;box-shadow:0 0 12px currentColor}
.ct-btn-ghost{background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:13px;padding:9px 16px;border-radius:8px;cursor:pointer;transition:.15s}
.ct-btn-ghost:hover{color:var(--text-2);border-color:var(--border-2)}
.ct-btn-solid{background:linear-gradient(135deg,var(--purple),var(--purple-deep));color:#fff;border:none;font-family:'Outfit';font-size:13px;font-weight:600;padding:9px 18px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 0 14px var(--glow-purple-2);transition:.15s}
.ct-btn-solid:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 0 20px var(--glow-purple-5)}
.ct-btn-solid:disabled{opacity:.6;cursor:not-allowed}
@media(max-width:600px){.ct-row-2,.ct-row-3{grid-template-columns:1fr}}

/* ===== INSTALLMENTS MOBILE LAYOUT ===== */
@media(max-width:880px){
  .ct-kpis{grid-template-columns:repeat(2,1fr);gap:10px}
  .ct-kpis .fp-kpi-val{font-size:22px}
}
@media(max-width:600px){
  .ct-kpis{grid-template-columns:repeat(2,1fr);gap:8px}
  .ct-kpis .fp-kpi{padding:14px 12px}
  .ct-kpis .fp-kpi-label{font-size:9.5px;letter-spacing:.7px}
  .ct-kpis .fp-kpi-val{font-size:20px;letter-spacing:-.4px}
  .ct-kpis .fp-kpi-sub{font-size:10.5px;line-height:1.3}
  .ct-filters{padding:12px;gap:10px;flex-direction:column;align-items:stretch}
  .ct-chips,.ct-buyer{justify-content:flex-start;flex-wrap:wrap}
  .ct-search{min-width:0;max-width:100%;width:100%;flex:none}
  .ct-cta{width:100%;justify-content:center}
  .ct-cards{grid-template-columns:1fr;gap:10px}
}

/* ===== INCOME & CONTRIBUTION BLOCK ===== */
.ib-block{padding:16px 18px 14px}
.ib-head-actions{display:flex;gap:5px;margin-left:auto}
.ib-icon-btn{display:flex;align-items:center;gap:5px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11.5px;padding:5px 9px;border-radius:7px;cursor:pointer;transition:.15s}
.ib-icon-btn:hover{border-color:var(--glow-purple);color:var(--purple-light);background:#a78bfa10}
.ib-icon-btn.ib-edit{background:linear-gradient(135deg,#a78bfa15,#7c3aed15);border-color:var(--glow-purple-2);color:var(--purple-light)}
.ib-icon-btn.ib-edit:hover{border-color:var(--purple);box-shadow:0 0 12px var(--glow-purple-2)}
.ib-section-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);letter-spacing:1.5px;margin-bottom:8px;font-weight:500}
.ib-person-row{display:grid;grid-template-columns:170px 1fr 24px 1fr 1fr;gap:13px;align-items:center;padding:11px 0;border-bottom:1px dashed var(--border-soft)}
.ib-person-row.ib-with-personal{grid-template-columns:170px 1fr 24px 1fr 1fr 24px 1fr 1fr}
.ib-person-row:last-of-type{border-bottom:none}
.ib-person-name{display:flex;flex-direction:column;gap:6px}
.ib-name{font-family:'Chakra Petch';font-size:14px;font-weight:600;color:var(--text);border-left:3px solid;padding-left:9px}
.ib-share-pill{font-family:'JetBrains Mono';font-size:10px;font-weight:500;letter-spacing:.4px;border:1px solid;padding:2px 7px;border-radius:5px;align-self:flex-start;margin-left:9px}
.ib-cell-label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);letter-spacing:1px;display:block;margin-bottom:5px}
.ib-auto{color:var(--purple);font-size:8.5px;background:#a78bfa15;padding:1px 5px;border-radius:3px;margin-left:5px;border:1px solid #a78bfa33}
.ib-input{display:flex;align-items:center;gap:7px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:0 11px;transition:.16s;position:relative}
.ib-input:focus-within{border-color:var(--cyan);box-shadow:0 0 0 3px var(--glow-cyan-3)}
.ib-input.saving{border-color:var(--amber-2)}
.ib-input.saved{border-color:var(--green)}
.ib-input span{font-family:'JetBrains Mono';font-size:11px;color:var(--text-faint)}
.ib-input input{background:none;border:none;outline:none;color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:14px;font-weight:600;width:100%;padding:8px 0;text-align:right}
.ib-arrow{color:var(--border-4);display:grid;place-items:center;padding-top:18px}
.ib-contrib-val{font-family:'JetBrains Mono';font-size:16px;font-weight:700;padding:7px 0;letter-spacing:-.3px}
.ib-surplus-val{font-family:'JetBrains Mono';font-size:14px;font-weight:600;padding:7px 0;letter-spacing:-.2px;display:flex;align-items:center;gap:5px}
.ib-surplus-val.pos{color:var(--teal)}.ib-surplus-val.warn{color:var(--amber)}

/* Personal Deduction cell in income row */
.ib-personal-cell{display:flex;flex-direction:column;gap:5px;padding-top:18px}
.ib-personal-label{color:var(--purple-light)!important;display:inline-flex;align-items:center;gap:4px}
.ib-personal-label svg{color:var(--purple)}
.ib-personal-val{font-family:'JetBrains Mono';font-size:14px;font-weight:600;color:var(--purple-light);padding:7px 0;letter-spacing:-.2px}

/* TAKE-HOME cell — final cash after personal deductions */
.ib-takehome-cell{display:flex;flex-direction:column;gap:5px;padding-top:18px}
.ib-takehome-label{color:var(--takehome-label)!important}
.ib-takehome-val{font-family:'JetBrains Mono';font-size:14px;font-weight:700;padding:7px 0;letter-spacing:-.2px;display:flex;align-items:center;gap:5px}
.ib-takehome-val.pos{color:var(--teal)}.ib-takehome-val.warn{color:var(--amber)}
.ib-arrow-personal{color:var(--glow-purple-3)}
.ib-arrow-empty,.ib-cell-empty{visibility:hidden}

/* "Updated" pulse indicator in Income block header */
.ib-pulse-tag{display:inline-flex;align-items:center;gap:4px;font-family:'JetBrains Mono';font-size:9.5px;color:var(--teal);background:#34d39915;border:1px solid var(--glow-green);padding:2px 7px;border-radius:4px;letter-spacing:.5px;font-weight:700;margin-left:8px;animation:ibPulseFade 1.2s cubic-bezier(.2,.8,.2,1) both}
@keyframes ibPulseFade{
  0%   {opacity:0; transform:scale(.7)}
  18%  {opacity:1; transform:scale(1.12)}
  35%  {transform:scale(1)}
  78%  {opacity:1}
  100% {opacity:0; transform:scale(.96)}
}

/* Personal item pill on line items */
.fp-li-personal-pill{display:inline-flex;align-items:center;gap:3px;font-family:'JetBrains Mono';font-size:8.5px;letter-spacing:.5px;font-weight:700;padding:1.5px 6px 1.5px 5px;border-radius:4px;border:1px solid;margin-left:7px;vertical-align:middle}

/* Edit modal — personal deduction section */
.lie-checkbox-label{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.lie-checkbox-label input[type=checkbox]{width:14px;height:14px;accent-color:var(--purple);cursor:pointer}
.lie-checkbox-label span{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:.8px;font-weight:600}
.lie-contrib-picker{margin-top:10px;padding:11px;background:var(--bg);border:1px solid var(--border);border-radius:8px}
.lie-contrib-sub-label{display:block;font-family:'JetBrains Mono';font-size:8.5px;color:var(--text-faint);letter-spacing:1px;margin-bottom:7px}
.lie-contrib-options{display:flex;gap:7px}
.lie-contrib-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);padding:9px 12px;border-radius:7px;font-family:'Outfit';font-size:12px;font-weight:600;cursor:pointer;transition:.15s}
.lie-contrib-btn:hover{border-color:var(--border-2);color:var(--text-2)}
.lie-preview{display:flex;align-items:flex-start;gap:7px;margin-top:10px;padding:9px 11px;background:#a78bfa12;border:1px solid var(--glow-purple-2);border-radius:7px;font-size:11px;color:var(--purple-light);line-height:1.5}
.lie-preview svg{flex-shrink:0;margin-top:2px;color:var(--purple)}
.lie-preview b{color:var(--text)}
.lie-preview-household{background:#22d3ee12;border-color:var(--glow-cyan-2);color:var(--cyan-bright)}
.lie-preview-household svg{color:var(--cyan)}

/* Dashboard — Personal Deductions card */
.fp-personal{margin-top:16px}
.fp-personal-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.fp-personal-card{background:var(--bg-2);border:1px solid;border-radius:10px;padding:13px}
.fp-personal-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:1px dashed var(--border);margin-bottom:8px}
.fp-personal-name{font-family:'Chakra Petch';font-size:14px;font-weight:600;letter-spacing:.3px}
.fp-personal-total{font-family:'JetBrains Mono';font-size:16px;font-weight:700;letter-spacing:-.3px}
.fp-personal-sub{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:.5px;margin-bottom:10px}
.fp-personal-breakdown{display:flex;flex-direction:column;gap:4px}
.fp-personal-cat{display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono';font-size:11px;color:var(--text-soft);padding:3px 0}
.fp-personal-cat b{color:var(--text-2);font-weight:600}

body.privacy-on .fp-personal-total,
body.privacy-on .fp-personal-cat b{
  filter:blur(7px);
  transition:filter .35s cubic-bezier(.22,.61,.36,1);
}
body.privacy-on .fp-personal-card:hover .fp-personal-total,
body.privacy-on .fp-personal-card:hover .fp-personal-cat b{
  filter:none;
  transition:filter .12s ease-out;
}

/* SURPLUS info tooltip — rendered via Portal so it escapes parent stacking contexts */
.ib-info-wrap{display:inline-flex;align-items:center;justify-content:center;margin-left:5px;width:14px;height:14px;border-radius:50%;border:1px solid var(--border-2);color:var(--text-dim);cursor:help;transition:.15s;vertical-align:middle}
.ib-info-wrap:hover,.ib-info-wrap:focus{color:var(--purple);border-color:var(--purple);outline:none}
.ib-info-wrap svg{display:block}
.ib-tooltip{width:300px;max-width:calc(100vw - 32px);background:linear-gradient(160deg,var(--dsurf-8),var(--dsurf-4));border:1px solid var(--glow-purple);border-radius:10px;padding:14px;font-family:'Outfit';font-size:12px;color:var(--text-2);line-height:1.55;box-shadow:0 0 28px #a78bfa33,0 18px 40px -10px #000;z-index:9999;text-transform:none;letter-spacing:normal;animation:tipIn .18s cubic-bezier(.2,.8,.2,1) both;pointer-events:none}
@keyframes tipIn{from{opacity:0;transform:translate(-50%,-4px) scale(.97)}to{opacity:1;transform:translateX(-50%)}}
.ib-tooltip strong{display:block;font-family:'Chakra Petch';font-size:11.5px;color:var(--purple-light);font-weight:600;letter-spacing:.5px;margin-bottom:7px}
.ib-tooltip p{margin:0 0 10px 0;font-size:11.5px;color:var(--text-soft);line-height:1.55}
.ib-tt-formula{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:9px 11px;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;margin-bottom:9px;font-family:'JetBrains Mono';font-size:10.5px}
.ib-tt-formula span{color:var(--text-dim);letter-spacing:.2px}
.ib-tt-formula b{color:var(--text);font-weight:600;text-align:right;letter-spacing:-.3px}
.ib-tt-formula b.pos{color:var(--teal)}
.ib-tt-formula b.warn{color:var(--amber)}
.ib-tt-note{font-size:10.5px;color:var(--text-dim);line-height:1.5;margin-bottom:0!important}

/* ===== Mobile centered overlay for Surplus tooltip =====
   Reuses the proven .ib-modal-bg + .card pattern (same as CopyMonthModal).
   Only overrides: bump z-index above other floats, cap card width. */
.ib-tt-modal-bg{z-index:9998!important}
.ib-tt-modal-card{width:100%!important;max-width:340px!important;padding:18px!important;max-height:78vh;overflow-y:auto}
.ib-tt-modal-card strong{display:block;font-family:'Chakra Petch';font-size:13px;color:#a855f7;letter-spacing:.5px;margin-bottom:8px}
.ib-tt-modal-card p{font-family:'Outfit';font-size:12.5px;color:var(--text-2);line-height:1.5;margin:0 0 10px}
.ib-tt-modal-card .ib-tt-formula{background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:'JetBrains Mono';font-size:11.5px;display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin-bottom:10px}
.ib-tt-modal-card .ib-tt-formula span{color:var(--text-dim)}
.ib-tt-modal-card .ib-tt-formula b{color:var(--text);font-weight:500;text-align:right}
.ib-tt-modal-card .ib-tt-formula b.pos{color:var(--teal)}
.ib-tt-modal-card .ib-tt-formula b.warn{color:var(--amber)}
.ib-summary{margin-top:14px;padding:11px 14px;background:var(--bg-2);border:1px solid var(--border-soft);border-radius:9px;display:flex;flex-direction:column;gap:7px}
.ib-summary-row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;font-family:'Outfit';font-size:12.5px}
.ib-summary-row.ib-net{padding-top:7px;border-top:1px solid var(--border);margin-top:3px;align-items:center}
.ib-sum-label{color:var(--text-dim);flex:1;min-width:0}
.ib-sum-val{font-family:'JetBrains Mono';font-weight:700;font-size:14px;white-space:nowrap;flex-shrink:0;text-align:right}
.ib-sum-val.pos{color:var(--teal)}.ib-sum-val.neg{color:var(--pink-light)}.ib-sum-val.warn{color:var(--amber)}
.ib-sum-val .fp-rm-pre{font-style:normal;font-size:10.5px;font-weight:500;opacity:.65;margin-right:3px;letter-spacing:.2px;color:inherit}
.ib-sum-breakdown{font-style:normal;font-size:10.5px;color:var(--text-faint);margin-left:8px;font-family:'JetBrains Mono'}
@media(max-width:640px){
  .ib-summary{padding:10px 12px}
  .ib-summary-row{font-size:12px;gap:10px}
  .ib-sum-val{font-size:13px}
  .ib-sum-val .fp-rm-pre{font-size:9.5px;margin-right:2px}
  .ib-sum-breakdown{display:block;margin-left:0;margin-top:3px;font-size:9.5px;line-height:1.4;color:#4a5b76}
}
.ib-hint{margin-top:12px;display:flex;gap:7px;align-items:flex-start;font-size:11px;color:var(--text-muted);line-height:1.5;padding:9px 11px;background:#ffffff03;border-radius:7px;border:1px dashed var(--border)}
.ib-hint svg{flex-shrink:0;margin-top:2px;color:var(--text-dim)}
.ib-hint strong{color:var(--text-soft);font-weight:500}
.ib-hint em{color:var(--purple-light);font-style:normal;font-weight:500}

/* MODAL */
.ib-modal-bg{position:fixed;inset:0;background:var(--dsurf-21);backdrop-filter:blur(8px);display:grid;place-items:center;z-index:50;padding:20px;animation:fade .2s ease-out}
@keyframes fade{from{opacity:0}to{opacity:1}}
.ib-modal{width:100%;max-width:520px;display:flex;flex-direction:column;animation:rise .3s cubic-bezier(.2,.8,.2,1)}
.ib-modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:1px solid var(--border-soft)}
.ib-modal-head h3{margin:0;font-family:'Chakra Petch';font-size:14px;font-weight:600;color:var(--text);letter-spacing:.5px;display:flex;align-items:center;gap:8px}
.ib-x{background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;padding:5px 7px;border-radius:6px;display:grid;place-items:center}
.ib-x:hover{color:var(--text-2);border-color:var(--border-2)}
.ib-modal-body{padding:18px 22px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;max-height:70vh}
.ib-modal-note{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;color:var(--text-soft);line-height:1.5;padding:10px 12px;background:#ffffff04;border-radius:8px;border:1px solid var(--border)}
.ib-modal-note svg{flex-shrink:0;margin-top:2px;color:var(--purple)}
.ib-modal-foot{padding:13px 22px;border-top:1px solid var(--border-soft);display:flex;justify-content:flex-end;gap:8px}
.ib-share-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ib-share-card{padding:13px;background:var(--bg-2);border:1px solid;border-radius:10px;position:relative}
.ib-share-card-label{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);letter-spacing:1px;margin-bottom:8px;text-transform:uppercase}
.ib-share-card-input{display:flex;align-items:baseline;gap:5px;margin-bottom:10px}
.ib-share-card-input input{background:none;border:none;outline:none;color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:28px;font-weight:700;width:60px;padding:0}
.ib-share-card-input input[readonly]{color:var(--pink-light);cursor:default}
.ib-share-card-input span{font-family:'JetBrains Mono';font-size:14px;color:var(--text-faint)}
.ib-slider{width:100%;height:5px;background:var(--border);border-radius:3px;outline:none;-webkit-appearance:none;cursor:pointer}
.ib-slider.person-a::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--cyan);cursor:pointer;box-shadow:0 0 8px var(--cyan)}
.ib-slider.person-b::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--pink);cursor:default;box-shadow:0 0 8px var(--pink)}
.ib-share-auto{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-faint);margin-top:5px;letter-spacing:.5px}
.ib-eff{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-soft);padding:11px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;flex-wrap:wrap}
.ib-eff select{background:var(--surface-3);border:1px solid var(--border);color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:12px;padding:5px 8px;border-radius:6px;outline:none;cursor:pointer}
.ib-eff select:focus{border-color:var(--purple)}
.ib-warn{display:flex;gap:8px;align-items:flex-start;font-size:11px;color:var(--amber);line-height:1.5;padding:9px 12px;background:#fbbf2410;border:1px solid #fbbf2430;border-radius:8px}
.ib-warn svg{flex-shrink:0;margin-top:2px;color:var(--amber-2)}
.ib-warn strong{color:#fef08a;font-weight:600}
.ib-btn-ghost{background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:12.5px;padding:8px 14px;border-radius:7px;cursor:pointer;transition:.15s}
.ib-btn-ghost:hover{color:var(--text-2);border-color:var(--border-2)}
.ib-btn-solid{background:linear-gradient(135deg,var(--purple),var(--purple-deep));color:#fff;border:none;font-family:'Outfit';font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 0 12px var(--glow-purple-2);transition:.15s}
.ib-btn-solid:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 0 18px var(--glow-purple-5)}
.ib-btn-solid:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.ib-history-row{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;gap:10px}
.ib-hr-when{display:flex;align-items:center;gap:7px;font-family:'JetBrains Mono';font-size:12px;color:var(--text-2);flex-shrink:0}
.ib-hr-when svg{color:var(--text-faint)}
.ib-current-pill{font-size:9px;color:var(--teal);background:#34d39915;border:1px solid var(--glow-green-3);padding:1px 6px;border-radius:4px;letter-spacing:.5px}
.ib-hr-split{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:1}
.ib-hr-share{font-family:'JetBrains Mono';font-size:10.5px;padding:3px 7px;border-radius:4px;font-weight:500;color:var(--cyan-bright);background:#22d3ee15;border:1px solid #22d3ee33}
.ib-hr-rm{background:none;border:1px solid var(--border);color:var(--text-faint);padding:3px 5px;border-radius:5px;cursor:pointer;display:grid;place-items:center;flex-shrink:0}
.ib-hr-rm:hover{color:var(--pink-light);border-color:#7c1d36}
@media(max-width:1100px){.ib-person-row.ib-with-personal{grid-template-columns:170px 1fr 24px 1fr 1fr;gap:13px}.ib-person-row.ib-with-personal .ib-arrow-personal{display:none}.ib-person-row.ib-with-personal .ib-personal-cell{grid-column:2/4}.ib-person-row.ib-with-personal .ib-takehome-cell{grid-column:4/6}}
@media(max-width:760px){
  /* Installment modal: lift above bottom nav (z-index) + leave room so the
     Create/Cancel footer is never hidden behind the fixed nav. */
  .ct-modal-bg{z-index:120!important;align-items:center!important;padding:calc(54px + env(safe-area-inset-top)) 14px calc(64px + env(safe-area-inset-bottom))!important}
  .ct-modal{max-height:calc(100dvh - 84px)!important}
  .ib-person-row,.ib-person-row.ib-with-personal{grid-template-columns:1fr 1fr;gap:12px 14px;padding:14px 0}
  .ib-arrow,.ib-arrow-personal{display:none}
  .ib-person-name{grid-column:1 / -1}
  .ib-salary-cell{grid-column:1 / -1}
  .ib-contrib-cell{grid-column:1;padding-top:0}
  .ib-surplus-cell{grid-column:2;padding-top:0}
  .ib-person-row.ib-with-personal .ib-personal-cell{grid-column:1;padding-top:0}
  .ib-person-row.ib-with-personal .ib-takehome-cell{grid-column:2;padding-top:0}
  .ib-arrow-empty,.ib-cell-empty{display:none!important}
}

/* ===== PRIVACY TOGGLE ===== */
.fp-privacy{display:flex;align-items:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11.5px;font-weight:500;padding:7px 12px;border-radius:30px;cursor:pointer;transition:.15s}
.fp-privacy:hover{border-color:var(--glow-cyan);color:var(--cyan-bright)}
.fp-privacy.on{background:linear-gradient(135deg,#7c3aed22,#a78bfa18);border-color:var(--glow-purple-3);color:var(--purple-light);box-shadow:0 0 12px #a78bfa33}

/* ===== PRIVACY BLUR — applied via body.privacy-on ===== */
body.privacy-on .fp-kpi-val,
body.privacy-on .fp-cat-amt,
body.privacy-on .fp-cat-pct,
body.privacy-on .fp-cat-subtotal,
body.privacy-on .fp-entry-totals b,
body.privacy-on .fp-input input,
body.privacy-on .fp-line-name em,
body.privacy-on .fp-tt b,
body.privacy-on .recharts-yAxis .recharts-cartesian-axis-tick text,
body.privacy-on .ct-money-v,
body.privacy-on .ct-big,
body.privacy-on .ib-contrib-val,
body.privacy-on .ib-surplus-val,
body.privacy-on .ib-personal-val,
body.privacy-on .ib-takehome-val{
  filter:blur(7px);
  transition:filter .35s cubic-bezier(.22,.61,.36,1);
}
.fp-kpi-val,.fp-cat-amt,.fp-cat-pct,.fp-cat-subtotal,.fp-entry-totals b,.fp-input input,.fp-line-name em,.fp-tt,.fp-tt b,.ct-money-v,.ct-big,.ib-contrib-val,.ib-surplus-val,.ib-personal-val,.ib-takehome-val,.ib-sum-val,.ib-input input,.fp-insight-value,.fp-insight-sub,.fp-yoy-pct,.sv-acc-balance,.sv-acc-delta-pill,.sv-tmf-step-value,.sv-tmf-target b,.sv-goal-current,.sv-goal-target,.sv-goal-pace b,.sv-snap-balance-val,.sv-snap-contrib-val,.fp-personal-total,.fp-personal-cat b{transition:filter .35s cubic-bezier(.22,.61,.36,1)}
body.privacy-on .ib-sum-val,
body.privacy-on .ib-input input,
body.privacy-on .fp-insight-value,
body.privacy-on .fp-insight-sub,
body.privacy-on .fp-yoy-pct{
  filter:blur(7px);
  transition:filter .35s cubic-bezier(.22,.61,.36,1);
}
body.privacy-on .fp-kpi-val:hover,
body.privacy-on .fp-cat-amt:hover,
body.privacy-on .fp-cat-pct:hover,
body.privacy-on .fp-cat-subtotal:hover,
body.privacy-on .fp-entry-totals b:hover,
body.privacy-on .fp-input:hover input,
body.privacy-on .fp-input:focus-within input,
body.privacy-on .fp-line-name em:hover,
body.privacy-on .ct-money-v:hover,
body.privacy-on .ct-big:hover,
body.privacy-on .ib-contrib-val:hover,
body.privacy-on .ib-surplus-val:hover,
body.privacy-on .ib-personal-val:hover,
body.privacy-on .ib-takehome-val:hover,
body.privacy-on .ib-sum-val:hover,
body.privacy-on .ib-input:hover input,
body.privacy-on .ib-input:focus-within input,
body.privacy-on .fp-insight-card:hover .fp-insight-value,
body.privacy-on .fp-insight-card:hover .fp-insight-sub,
body.privacy-on .fp-yoy-row:hover .fp-yoy-pct{
  filter:none;
  transition:filter .12s ease-out;
}
/* Hide tooltip entirely when private (no hover reveal trick for chart tips) */
body.privacy-on .fp-tt{filter:blur(7px);transition:filter .35s cubic-bezier(.22,.61,.36,1)}
body.privacy-on .fp-tt:hover{filter:none;transition:filter .12s ease-out}

/* Privacy snap effect — brief screen sweep when toggling */
.fp-privacy-sweep{position:fixed;inset:0;pointer-events:none;z-index:9998;
  background:radial-gradient(ellipse at center, rgba(167,139,250,.18) 0%, rgba(167,139,250,0) 60%);
  opacity:0;transform:scale(.6)}
.fp-privacy-sweep.snapping{animation:privacySnap .55s cubic-bezier(.16,.84,.44,1) both}
@keyframes privacySnap{
  0%   {opacity:0; transform:scale(.6)}
  35%  {opacity:1; transform:scale(1.15)}
  100% {opacity:0; transform:scale(1.6)}
}

/* ===== DELETE LINE ITEM BUTTON ===== */
.fp-line-wrap{display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:8px;position:relative;padding:6px 0;border-bottom:1px dashed #ffffff05}
.fp-line-wrap:last-child{border-bottom:none}
.fp-line-wrap .fp-line{display:grid;grid-template-columns:1fr 130px;align-items:center;gap:10px;padding:0;border-bottom:none}
.fp-line-name{font-size:13px;color:var(--text-2);line-height:1.32;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;word-break:break-word;flex:1;min-width:0}
.fp-li-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;cursor:text}
.fp-line-name em{display:block;font-style:normal;font-size:10.5px;color:var(--text-faint);font-family:'JetBrains Mono';margin-top:1px;line-height:1.2}
.fp-input{width:130px;min-width:0;justify-self:end}
.fp-input input{width:74px}
.fp-line-del{background:none;border:1px solid var(--border);color:var(--text-faint);cursor:pointer;padding:4px;border-radius:6px;display:grid;place-items:center;opacity:0;transition:.15s;flex-shrink:0}
.fp-line-wrap:hover .fp-line-del{opacity:1}
.fp-line-del:hover:not(:disabled){color:var(--text-2);border-color:var(--border-2);background:#ffffff05}
.fp-line-del:disabled{opacity:.35!important;cursor:not-allowed}
.fp-line-del.danger:hover{color:var(--pink-light);border-color:#7c1d36;background:#fb718510}

/* 3-dot menu on line items (rendered via Portal at document.body level
   to escape parent card's backdrop-filter stacking context) */
.fp-li-menu{min-width:210px;background:linear-gradient(160deg,var(--dsurf-7),var(--dsurf-3));border:1px solid var(--border);border-radius:8px;padding:5px;z-index:9999;animation:popIn .15s ease-out;box-shadow:0 12px 30px -8px #000,0 0 0 1px #ffffff05 inset}
@keyframes popIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.fp-li-menu button{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;color:var(--text-2);font-family:'Outfit';font-size:11.5px;padding:7px 9px;border-radius:6px;cursor:pointer;text-align:left;transition:.12s}
.fp-li-menu button svg{color:var(--text-dim);flex-shrink:0}
.fp-li-menu button:hover{background:#ffffff06;color:var(--text)}
.fp-li-menu button:hover svg{color:var(--purple)}
.fp-li-menu button:first-child:hover{background:#34d39910;color:var(--teal)}
.fp-li-menu button:first-child:hover svg{color:var(--teal)}
.fp-li-menu-danger:hover{background:#fb718510!important;color:var(--pink-light)!important}
.fp-li-menu-danger:hover svg{color:var(--pink-light)!important}

/* Line item edit modal fields */
.lie-field{display:flex;flex-direction:column;gap:6px}
.lie-field label{font-family:'JetBrains Mono';font-size:9.5px;color:var(--text-dim);letter-spacing:1px;font-weight:500;text-transform:uppercase}
.lie-opt{color:var(--text-faint);font-weight:400;letter-spacing:.3px;text-transform:none}
.lie-field input[type=text],.lie-field select{background:var(--bg-2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-family:'Outfit';font-size:13px;padding:9px 11px;outline:none;transition:.15s;width:100%;box-sizing:border-box}
.lie-field input[type=text]:focus,.lie-field select:focus{border-color:var(--purple);box-shadow:0 0 0 3px var(--glow-purple-4)}
.lie-field small{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--text-faint);margin-top:1px;line-height:1.3}
.lie-field small svg{color:var(--text-dim);flex-shrink:0}

/* ===== START NEW YEAR WIZARD ===== */
.fp-fy-new{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,var(--glow-purple-4),#7c3aed18);border:1px solid var(--glow-purple);color:var(--purple-light);font-family:'JetBrains Mono';font-size:11px;font-weight:500;padding:6px 12px;border-radius:8px;cursor:pointer;transition:.15s;margin-left:6px}
.fp-fy-new:hover{border-color:var(--purple);background:linear-gradient(135deg,#a78bfa33,#7c3aed22);box-shadow:0 0 12px var(--glow-purple-2)}
.sny-modal{max-width:720px!important}
.sny-steps{display:flex;align-items:center;gap:8px;padding:13px 22px;border-bottom:1px solid var(--border-soft);font-family:'JetBrains Mono';font-size:10.5px;color:var(--border-4);letter-spacing:.5px;overflow-x:auto}
.sny-steps span{color:var(--border-4);flex-shrink:0;transition:.2s}
.sny-steps span.on{color:var(--purple-light)}
.sny-steps svg{color:var(--border);flex-shrink:0}
.sny-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.sny-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.sny-field label{font-family:'JetBrains Mono';font-size:10px;color:var(--text-dim);letter-spacing:1px;text-transform:uppercase;font-weight:500}
.sny-field select{background:var(--bg-2);border:1px solid var(--border);color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:12.5px;padding:9px 11px;border-radius:8px;outline:none;cursor:pointer;width:100%;box-sizing:border-box;transition:.15s}
.sny-field select:focus{border-color:var(--purple);box-shadow:0 0 0 3px var(--glow-purple-4)}
.sny-field small{font-size:10.5px;color:var(--text-faint);font-family:'Outfit';line-height:1.4}
.sny-row{display:flex;gap:8px}
.sny-row select{flex:1}
.sny-bulk{display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px}
.sny-bulk button{display:flex;align-items:center;gap:5px;background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;transition:.15s}
.sny-bulk button:hover{border-color:var(--glow-purple);color:var(--purple-light)}
.sny-bulk-info{margin-left:auto;font-family:'JetBrains Mono';font-size:10.5px;color:var(--text-dim)}
.sny-cat-group{background:var(--bg-2);border:1px solid var(--border-soft);border-radius:9px;padding:8px;display:flex;flex-direction:column;gap:3px}
.sny-cat-head{display:flex;align-items:center;gap:8px;padding:5px 6px;border-bottom:1px solid var(--border-soft);font-family:'Chakra Petch';font-size:12.5px;color:var(--text-2);font-weight:600;margin-bottom:3px}
.sny-cat-head input[type=checkbox]{accent-color:var(--purple);cursor:pointer}
.sny-cat-head svg{color:var(--cyan)}
.sny-item{display:grid;grid-template-columns:18px 1fr 130px;align-items:center;gap:10px;padding:6px 6px;border-radius:6px;transition:.12s}
.sny-item:hover{background:#ffffff03}
.sny-item input[type=checkbox]{accent-color:var(--purple);cursor:pointer;margin:0}
.sny-item-name{font-size:12px;color:var(--text-2);line-height:1.3;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;min-width:0}
.sny-item-amt{display:flex;align-items:center;gap:6px;background:var(--surface-3);border:1px solid var(--border);border-radius:7px;padding:0 9px;transition:.15s}
.sny-item-amt:focus-within{border-color:var(--cyan);box-shadow:0 0 0 2px var(--glow-cyan-3)}
.sny-item-amt span{font-family:'JetBrains Mono';font-size:10px;color:var(--text-faint)}
.sny-item-amt input{background:none;border:none;outline:none;color:var(--cyan-bright);font-family:'JetBrains Mono';font-size:12px;font-weight:600;width:100%;padding:6px 0;text-align:right}
.sny-item-amt input:disabled{color:var(--border-4);cursor:not-allowed}
.sny-archive-hint{font-family:'JetBrains Mono';font-size:10px;color:var(--text-faint);text-align:right;font-style:italic}
.sny-toggle{display:flex;align-items:center;gap:9px;padding:11px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;cursor:pointer;font-size:13px;color:var(--text-2)}
.sny-toggle input[type=checkbox]{accent-color:var(--purple);cursor:pointer;width:15px;height:15px}
.sny-summary{display:flex;flex-direction:column;gap:7px;padding:13px 15px;background:var(--bg-2);border:1px solid var(--border-soft);border-radius:10px}
.sny-summary-row{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--text-soft);padding:4px 0}
.sny-summary-row b{font-family:'JetBrains Mono';font-size:12.5px;color:var(--purple-light);font-weight:600}
@media(max-width:600px){.sny-grid{grid-template-columns:1fr}.sny-item{grid-template-columns:18px 1fr;gap:8px}.sny-item-amt{grid-column:1/-1}}

.fp-line-ctrls{display:flex;gap:3px;flex-shrink:0;opacity:0;transition:.15s;margin-left:4px}
.fp-line-wrap:hover .fp-line-ctrls{opacity:1}

/* ===== DRAG-AND-DROP ===== */
.fp-drag-grip{font-family:'JetBrains Mono';font-size:12px;color:var(--border-4);letter-spacing:-2px;cursor:grab;user-select:none;padding:0 4px 0 0;transition:color .15s}
.fp-block-head:hover .fp-drag-grip{color:var(--text-dim)}
.fp-block-head[draggable="true"]{cursor:grab}
.fp-block-head[draggable="true"]:active{cursor:grabbing}

.fp-drag-grip-row{font-family:'JetBrains Mono';font-size:10px;color:transparent;letter-spacing:-2px;user-select:none;cursor:grab;transition:color .15s;text-align:center}
.fp-line-wrap:hover .fp-drag-grip-row{color:var(--text-faint)}
.fp-line-wrap[draggable="true"]:active{cursor:grabbing}

.fp-cat-drop{position:relative;transition:transform .15s ease}
.fp-cat-drop.dragging{opacity:.35}
.fp-cat-drop.over::before{content:'';position:absolute;left:-6px;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--cyan),var(--purple));border-radius:2px;box-shadow:0 0 14px var(--glow-cyan-5);z-index:5}
.fp-li-dnd{position:relative;transition:transform .12s ease}
.fp-li-dnd.dragging{opacity:.4}
.fp-li-dnd.over::before{content:'';position:absolute;left:0;right:0;top:-2px;height:2px;background:linear-gradient(90deg,var(--cyan),var(--purple));border-radius:2px;box-shadow:0 0 10px var(--glow-cyan-5);z-index:5}

/* category-level controls in header */
.fp-cat-controls{display:flex;gap:3px;margin-left:auto;opacity:0;transition:.15s}
.fp-block-head:hover .fp-cat-controls{opacity:1}
.fp-cat-ctrl{background:none;border:1px solid var(--border);color:var(--text-faint);cursor:pointer;padding:4px 5px;border-radius:6px;display:grid;place-items:center;transition:.15s;margin-left:auto;opacity:0}
.fp-block-head:hover .fp-cat-ctrl{opacity:1}
.fp-cat-ctrl:hover:not(:disabled){color:var(--cyan);border-color:var(--glow-cyan);background:#22d3ee10}
.fp-cat-ctrl:disabled{opacity:.35;cursor:not-allowed}
.fp-cat-ctrl.fp-cat-del:hover:not(:disabled){color:var(--pink-light);border-color:#7c1d36;background:#fb718510}

.fp-cat-edit{background:var(--bg-2);border:1px solid var(--glow-cyan);border-radius:6px;color:var(--text);font-family:'Chakra Petch';font-size:14px;font-weight:600;padding:4px 8px;outline:none;flex:1;min-width:0;max-width:200px}
.fp-cat-edit:focus{border-color:var(--cyan);box-shadow:0 0 0 3px var(--glow-cyan-3)}
.fp-li-edit{background:var(--bg-2);border:1px solid var(--glow-cyan);border-radius:6px;color:var(--text);font-family:'Outfit';font-size:13px;padding:3px 7px;outline:none;width:100%}
.fp-li-edit:focus{border-color:var(--cyan);box-shadow:0 0 0 3px var(--glow-cyan-3)}

/* ===== TRUE MASONRY (CSS multi-column) =====
   Each card stays at its NATURAL height. Cards flow into columns and
   shorter cards in a column leave room for the next card to flow up
   into that space — eliminating dead vertical gaps.
   column-width:320px = responsive: as many ~320px columns as fit. */
.fp-masonry{
  column-width:320px;
  column-gap:16px;
  column-fill:balance;
}
.fp-masonry > *{
  display:block;
  break-inside:avoid;
  -webkit-column-break-inside:avoid;
  page-break-inside:avoid;
  margin-bottom:16px;
  width:100%;
}
/* Income block sits ABOVE the masonry, full width */
.ib-block{margin-bottom:16px}

/* ===== PWA install prompt ===== */
.pwa-prompt{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:12px 14px;background:linear-gradient(160deg,var(--dsurf-7),var(--dsurf-3));border:1px solid var(--glow-cyan);border-radius:14px;box-shadow:0 0 28px var(--glow-cyan-3),0 18px 50px -10px #000;backdrop-filter:blur(12px);z-index:9997;max-width:calc(100vw - 28px);width:380px;animation:pwaIn .35s cubic-bezier(.2,.8,.2,1)}
@keyframes pwaIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translateX(-50%)}}
.pwa-prompt-icon{width:38px;height:38px;border-radius:10px;background:var(--bg);border:1px solid var(--border);display:grid;place-items:center;flex-shrink:0;box-shadow:0 0 14px #22d3ee33}
.pwa-prompt-icon svg{width:30px;height:30px}
.pwa-prompt-body{flex:1;min-width:0}
.pwa-prompt-title{font-family:'Chakra Petch';font-size:13px;font-weight:600;color:var(--text);letter-spacing:.3px;line-height:1.2}
.pwa-prompt-sub{font-family:'Outfit';font-size:11px;color:var(--text-dim);margin-top:2px;line-height:1.35}
.pwa-prompt-actions{display:flex;gap:6px;flex-shrink:0}
.pwa-prompt-x{background:none;border:1px solid var(--border);color:var(--text-dim);font-family:'Outfit';font-size:11px;font-weight:500;padding:7px 11px;border-radius:8px;cursor:pointer;transition:.15s}
.pwa-prompt-x:hover{border-color:var(--border-2);color:var(--text-2)}
.pwa-prompt-yes{background:linear-gradient(135deg,var(--cyan),#0891b2);border:none;color:var(--on-accent);font-family:'Outfit';font-size:11.5px;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;box-shadow:0 0 14px var(--glow-cyan);transition:.15s;letter-spacing:.3px}
.pwa-prompt-yes:hover{transform:translateY(-1px);box-shadow:0 0 20px var(--glow-cyan-5)}
@media(max-width:480px){.pwa-prompt{left:10px;right:10px;bottom:calc(78px + env(safe-area-inset-bottom));transform:none;width:auto;max-width:none;padding:10px 12px}.pwa-prompt:not(:has(*)){display:none}}
@media(max-width:760px){.fp-fab{bottom:calc(18px + env(safe-area-inset-bottom));right:calc(18px + env(safe-area-inset-right))}}

/* Standalone-mode tweaks (PWA launched from home screen) */
@media (display-mode: standalone){
  body{padding-top:env(safe-area-inset-top)}
  .fp-foot{padding-bottom:calc(6px + env(safe-area-inset-bottom))}
}
</style>
</head>
<body>
<div id="root">
  <div class="boot">
    <div class="boot-spinner"></div>
    <div>INITIALIZING&nbsp;FINANCE&nbsp;OPS</div>
  </div>
</div>
<script type="text/babel" data-presets="env,react">
const { useState, useEffect, useMemo, useCallback, useRef } = React;
const { AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } = Recharts;

/* ===== INLINE SVG ICONS (Lucide-style) ===== */
const SVG = (inner) => ({size=16}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       dangerouslySetInnerHTML={{__html: inner}} />
);
const Home = SVG('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>');
const CreditCard = SVG('<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>');
const Receipt = SVG('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>');
const Shield = SVG('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>');
const Car = SVG('<path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>');
const Tv = SVG('<rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>');
const Package = SVG('<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/>');
const LayoutDashboard = SVG('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>');
const Table2 = SVG('<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>');
const Plus = SVG('<path d="M5 12h14"/><path d="M12 5v14"/>');
const Sun = SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>');
const Moon = SVG('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');
const Zap = SVG('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>');
const ListIcon = SVG('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>');
const CalendarDays = SVG('<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M8 2v4M16 2v4M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>');
const TrendingUp = SVG('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>');
const TrendingDown = SVG('<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>');
const Wallet = SVG('<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>');
const ArrowUpRight = SVG('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>');
const ArrowDownRight = SVG('<path d="m7 7 10 10"/><path d="M17 7v10H7"/>');
const Lock = SVG('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>');
const Activity = SVG('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>');
const CircleDollarSign = SVG('<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>');
const Check = SVG('<polyline points="20 6 9 17 4 12"/>');
const Smartphone = SVG('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>');
const Sofa = SVG('<path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 11v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-4 0Z"/><path d="M4 18v2"/><path d="M20 18v2"/>');
const Refrigerator = SVG('<path d="M5 6a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M5 10h14"/><path d="M15 7v6"/>');
const Bed = SVG('<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>');
const Plane = SVG('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>');
const Stethoscope = SVG('<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>');
const Gamepad2 = SVG('<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>');
const ToyBrick = SVG('<rect width="18" height="12" x="3" y="8" rx="1"/><path d="M10 8V5c0-.6-.4-1-1-1H6a1 1 0 0 0-1 1v3"/><path d="M19 8V5c0-.6-.4-1-1-1h-3a1 1 0 0 0-1 1v3"/>');
const Droplets = SVG('<path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/>');
const X = SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const Search = SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>');
const Calendar = SVG('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>');
const Flame = SVG('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>');
const Target = SVG('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>');
const Award = SVG('<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>');
const ArrowUp = SVG('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>');
const ArrowDown = SVG('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>');
const Heart = SVG('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>');
const Trophy = SVG('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>');
const Briefcase = SVG('<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>');
const Gift = SVG('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 5.5 12 8c0-2.5 2.5-5 4.5-5a2.5 2.5 0 0 1 0 5"/>');
const GraduationCap = SVG('<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>');
const Sparkles = SVG('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>');
const CheckCircle2 = SVG('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>');
const AlertTriangle = SVG('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>');
const AlertCircle = SVG('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>');
const Clock = SVG('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
const XCircle = SVG('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>');
const RotateCcw = SVG('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>');
const User = SVG('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>');
const Users = SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>');
const Trash2 = SVG('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>');
const Pencil = SVG('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>');
const Settings2 = SVG('<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>');
const History = SVG('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>');
const Info = SVG('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const ArrowRight = SVG('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>');
const Eye = SVG('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');
const EyeOff = SVG('<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>');
const ChevronUp = SVG('<polyline points="18 15 12 9 6 15"/>');
const ChevronDown = SVG('<polyline points="6 9 12 15 18 9"/>');
const ChevronLeft = SVG('<polyline points="15 18 9 12 15 6"/>');
const ChevronRight = SVG('<polyline points="9 18 15 12 9 6"/>');
const Rocket = SVG('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>');
const Archive = SVG('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>');
const Copy = SVG('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
const MoreVertical = SVG('<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>');
const Edit3 = SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7.5 19l-4 1 1-4L16.5 3.5z"/>');
const ICONS = {home: Home, "credit-card": CreditCard, receipt: Receipt, shield: Shield, car: Car, tv: Tv, package: Package};
const INST_ICONS = {Smartphone, Tv, Sofa, Refrigerator, Box: Package, Gamepad2, Plane, Stethoscope, ToyBrick, Bed, Droplets, Car, CreditCard};
const INST_ICON_LIST = ["Smartphone","Tv","Sofa","Bed","Refrigerator","Plane","Gamepad2","ToyBrick","Stethoscope","Droplets","Car","Box","CreditCard"];

/* ===== CONSTANTS ===== */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ACCENT = ["var(--cyan)","var(--purple)","#f59e0b","var(--green)","var(--pink)","#60a5fa","var(--red)","#818cf8"];
const rm = (n) => "RM " + (Math.round((n||0)*100)/100).toLocaleString("en-MY", {minimumFractionDigits:0, maximumFractionDigits:2});
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const t = await r.text().catch(()=>r.statusText);
    throw new Error(\`\${r.status}: \${t}\`);
  }
  return r.json();
};

/* ===== MAIN APP ===== */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { this.setState({ err, info }); console.error('[ErrorBoundary]', err, info); }
  render() {
    if (this.state.err) return this.props.fallback(this.state.err, this.state.info);
    return this.props.children;
  }
}

function App() {
  const [boot, setBoot] = useState(null);
  const [me, setMe] = useState(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [tab, setTab] = useState("dashboard");
  const [summary, setSummary] = useState(null);
  const [entryMonth, setEntryMonth] = useState(new Date().getMonth()+1);
  const [monthData, setMonthData] = useState(null);
  const [err, setErr] = useState(null);
  const [clock, setClock] = useState(new Date());
  const [startYearOpen, setStartYearOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [helpAnchor, setHelpAnchor] = useState(null);

  const openHelp = useCallback((e) => {
    const target = (e && e.currentTarget) || document.querySelector('.fp-help-btn');
    if (target) setHelpAnchor(target.getBoundingClientRect());
  }, []);
  const closeHelp = useCallback(() => setHelpAnchor(null), []);

  // Liquid Glass mouse tracker — updates --mx, --my, --proximity on all .lg-fx elements
  useEffect(() => {
    let mouseX = 0, mouseY = 0;
    let scheduled = false;
    function tick() {
      scheduled = false;
      const els = document.querySelectorAll('.lg-fx, .card, .ln-bal-block, .ln-recon, .ln-np, .fp-loans-card, .fp-loans-mini, .fp-insight-card, .ln-hero, .ln-stat');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -100 || rect.top > window.innerHeight + 100) continue;
        const lx = mouseX - rect.left;
        const ly = mouseY - rect.top;
        el.style.setProperty('--mx', lx + 'px');
        el.style.setProperty('--my', ly + 'px');
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = mouseX - cx;
        const dy = mouseY - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const range = Math.max(rect.width, rect.height) + 60;
        const prox = Math.max(0, 1 - dist / range);
        el.style.setProperty('--proximity', prox.toFixed(3));
      }
    }
    function onMove(e) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(tick);
      }
    }
    document.addEventListener('mousemove', onMove, { passive: true });
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName;
      if (e.key === '?' && !['INPUT','TEXTAREA','SELECT'].includes(tag) && !e.target.isContentEditable) {
        e.preventDefault();
        const btn = document.querySelector('.fp-help-btn');
        if (btn) setHelpAnchor(btn.getBoundingClientRect());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Show a toast. opts: { duration?, action?: { label, onClick } }
  const showToast = useCallback((message, opts = {}) => {
    setToast({ message, ...opts });
  }, []);

  useEffect(() => { window.__mam_toast = showToast; return () => { delete window.__mam_toast; }; }, [showToast]);

  // Auto-clear toast — longer when there's an action button (gives time to click Undo)
  useEffect(() => {
    if (!toast) return;
    const duration = (typeof toast === 'object' && toast.duration)
      || (typeof toast === 'object' && toast.action ? 8000 : 4000);
    const t = setTimeout(() => setToast(null), duration);
    return () => clearTimeout(t);
  }, [toast]);
  const [privacy, setPrivacy] = useState(() => {
    try { return localStorage.getItem('mam-privacy') === '1'; } catch { return false; }
  });
  const [privacySnap, setPrivacySnap] = useState(false);
  const privacyMountRef = useRef(false);

  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('mam-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try { localStorage.setItem('mam-theme', theme); } catch {}
  }, [theme]);

  useEffect(()=>{const t=setInterval(()=>setClock(new Date()),1000);return()=>clearInterval(t)},[]);

  useEffect(() => {
    document.body.classList.toggle('privacy-on', privacy);
    try { localStorage.setItem('mam-privacy', privacy ? '1' : '0'); } catch {}
    // Trigger snap animation on every toggle EXCEPT initial mount
    if (privacyMountRef.current) {
      setPrivacySnap(true);
      const t = setTimeout(() => setPrivacySnap(false), 600);
      return () => clearTimeout(t);
    } else {
      privacyMountRef.current = true;
    }
  }, [privacy]);

  // Bootstrap
  useEffect(() => {
    (async () => {
      try {
        const [b, w] = await Promise.all([
          api('/api/bootstrap'),
          api('/api/whoami').catch(()=>({email:null}))
        ]);
        setBoot(b);
        setMe(w);
        const years = [...new Set(b.periods.map(p=>p.year))].sort();
        if (years.length) setYear(years[years.length-1]);
      } catch(e) { setErr(String(e.message||e)); }
    })();
  }, []);

  // Dashboard data (all charts + insights in one round trip)
  useEffect(() => {
    if (!boot) return;
    api(\`/api/dashboard?year=\${year}\`).then(setSummary).catch(e=>setErr(String(e.message||e)));
  }, [year, boot]);

  // Month data (for entry view)
  const reloadMonth = useCallback(() => {
    if (!boot) return;
    Promise.all([
      api(\`/api/entries?year=\${year}&month=\${entryMonth}\`),
      api(\`/api/income?year=\${year}&month=\${entryMonth}\`)
    ]).then(([e, i]) => {
      setMonthData({
        entries: e.entries,
        income: i.income,
        monthly_expense: i.monthly_expense || 0,
        installment_burden: i.installment_burden || 0,
        personal_by_contributor: i.personal_by_contributor || {}
      });
    }).catch(e => setErr(String(e.message||e)));
  }, [year, entryMonth, boot]);
  useEffect(() => { reloadMonth(); }, [reloadMonth]);

  const refreshSummary = () => api(\`/api/dashboard?year=\${year}\`).then(setSummary).catch(()=>{});

  const saveExpense = async (line_item_id, amount) => {
    const v = parseFloat(amount) || 0;
    await api('/api/entries', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({year, month: entryMonth, line_item_id, amount: v})
    });
    // Look up whether this item is personal (and whose) from boot
    const liById = Object.fromEntries((boot?.line_items || []).map(li => [li.id, li]));
    setMonthData(m => {
      const entries = m.entries.map(e =>
        e.line_item_id === line_item_id ? {...e, amount: v} : e);
      // Household-only sum (exclude personal items)
      const hhSum = entries.reduce((s, e) => {
        const li = liById[e.line_item_id];
        return li && li.is_personal ? s : s + (e.amount || 0);
      }, 0);
      const monthly_expense = hhSum + (m.installment_burden || 0);
      // Recompute personal_by_contributor optimistically
      const personalByContributor = {};
      for (const e of entries) {
        const li = liById[e.line_item_id];
        if (li && li.is_personal && li.assigned_contributor_id) {
          personalByContributor[li.assigned_contributor_id] =
            (personalByContributor[li.assigned_contributor_id] || 0) + (e.amount || 0);
        }
      }
      return {...m, entries, monthly_expense, personal_by_contributor: personalByContributor};
    });
    refreshSummary();
  };

  const saveIncome = async (contributor_id, salary) => {
    const v = parseFloat(salary) || 0;
    await api('/api/income', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({year, month: entryMonth, contributor_id, salary: v})
    });
    setMonthData(m => ({...m, income: m.income.map(i =>
      i.contributor_id === contributor_id ? {...i, salary: v} : i
    )}));
    refreshSummary();
  };

  const reloadAfterShareChange = async () => {
    reloadMonth();
    refreshSummary();
  };

  const addLineItem = async (category_id, name, note = '') => {
    const res = await api('/api/line-items', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({category_id, name, note})
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
    if (res?.restored) {
      showToast(\`Restored archived "\${name}" — historical entries are preserved\`);
    } else {
      showToast(\`Added "\${name}"\`);
    }
  };

  const deleteLineItem = async (line_item_id) => {
    // Capture name BEFORE delete so Undo toast can reference it
    const item = (boot?.line_items || []).find(li => li.id === line_item_id);
    const itemName = item?.name || 'item';

    // Soft-delete: set active=0. Historical data is preserved.
    await api(\`/api/line-items/\${line_item_id}\`, {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({active: 0})
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
    refreshSummary();
    showToast(\`Deleted "\${itemName}"\`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await api(\`/api/line-items/\${line_item_id}\`, {
              method:'PATCH', headers:{'content-type':'application/json'},
              body: JSON.stringify({active: 1})
            });
            const fresh2 = await api('/api/bootstrap');
            setBoot(fresh2);
            reloadMonth();
            refreshSummary();
            showToast(\`Restored "\${itemName}"\`);
          } catch (e) { alert('Undo failed: ' + e.message); }
        }
      }
    });
  };

  const renameLineItem = async (line_item_id, name) => {
    await api(\`/api/line-items/\${line_item_id}\`, {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({name})
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
  };

  // Edit name + note + (optionally) category in one go
  const editLineItem = async (line_item_id, patch) => {
    await api(\`/api/line-items/\${line_item_id}\`, {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify(patch)
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
    const updated = fresh.line_items.find(li => li.id === line_item_id);
    showToast(\`Updated "\${updated?.name || 'item'}"\`);
  };

  // Duplicate: create a new line item based on source's category/name/note
  const duplicateLineItem = async (source) => {
    const res = await api('/api/line-items', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        category_id: source.category_id,
        name: source.name + ' (copy)',
        note: source.note || ''
      })
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
    if (res?.restored) {
      showToast(\`Restored archived "\${source.name} (copy)"\`);
    } else {
      showToast(\`Duplicated "\${source.name}"\`);
    }
  };

  const moveLineItem = async (item, direction, siblings) => {
    // Sort siblings by current sort_order (stable on id as tiebreaker)
    const sorted = [...siblings].sort((a,b) =>
      ((a.sort_order||0) - (b.sort_order||0)) || (a.id - b.id));
    const idx = sorted.findIndex(x => x.id === item.id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= sorted.length) return;
    [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
    const updates = sorted.map((x, i) => ({ id: x.id, sort_order: i }));
    await api('/api/line-items/reorder', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(updates)
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
  };

  const reorderLineItems = async (orderedIds) => {
    const updates = orderedIds.map((id, i) => ({ id, sort_order: i }));
    await api('/api/line-items/reorder', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(updates)
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
  };

  const renameCategory = async (cat_id, name) => {
    await api(\`/api/categories/\${cat_id}\`, {
      method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({name})
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    refreshSummary();
  };

  const deleteCategory = async (cat) => {
    // Snapshot which line items will be cascade-archived, so Undo can restore them too
    const cascadedIds = (boot?.line_items || [])
      .filter(li => li.category_id === cat.id && li.active)
      .map(li => li.id);
    const catName = cat.name;

    await api(\`/api/categories/\${cat.id}\`, {method:'DELETE'});
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
    reloadMonth();
    refreshSummary();
    showToast(\`Deleted category "\${catName}"\${cascadedIds.length ? \` and \${cascadedIds.length} line item\${cascadedIds.length > 1 ? 's' : ''}\` : ''}\`, {
      duration: 10000,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await api(\`/api/categories/\${cat.id}\`, {
              method:'PATCH', headers:{'content-type':'application/json'},
              body: JSON.stringify({active: 1})
            });
            for (const liId of cascadedIds) {
              await api(\`/api/line-items/\${liId}\`, {
                method:'PATCH', headers:{'content-type':'application/json'},
                body: JSON.stringify({active: 1})
              });
            }
            const fresh2 = await api('/api/bootstrap');
            setBoot(fresh2);
            reloadMonth();
            refreshSummary();
            showToast(\`Restored category "\${catName}"\`);
          } catch (e) { alert('Undo failed: ' + e.message); }
        }
      }
    });
  };

  const moveCategory = async (cat, direction) => {
    const sorted = [...boot.categories].sort((a,b) =>
      ((a.sort_order||0) - (b.sort_order||0)) || (a.id - b.id));
    const idx = sorted.findIndex(x => x.id === cat.id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= sorted.length) return;
    [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
    const updates = sorted.map((x, i) => ({ id: x.id, sort_order: i }));
    await api('/api/categories/reorder', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(updates)
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
  };

  const reorderCategories = async (orderedIds) => {
    const updates = orderedIds.map((id, i) => ({ id, sort_order: i }));
    await api('/api/categories/reorder', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(updates)
    });
    const fresh = await api('/api/bootstrap');
    setBoot(fresh);
  };

  if (err) return <ErrorView error={err} onRetry={()=>{setErr(null); location.reload();}} />;
  if (!boot || !summary) return <Boot />;

  const years = [...new Set(boot.periods.map(p=>p.year))].sort();
  if (years.length===0) years.push(new Date().getFullYear());

  return (
    <div className="fp-root">
      <div className="fp-grid-bg" />
      <div className="fp-glow fp-glow-1" />
      <div className="fp-glow fp-glow-2" />
      <div className={\`fp-privacy-sweep \${privacySnap ? "snapping" : ""}\`} />
      <div className="fp-sticky-top">
      <header className="fp-top">
        <div className="fp-brand">
          <div className="fp-logo-wrap">
            <div className="fp-logo-halo"/>
            <div className="fp-logo"><svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="fp-logo-svg">
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--cyan)" stroke-width="2" opacity="0.75"/>
        <circle cx="60" cy="60" r="38" fill="none" stroke="var(--cyan)" stroke-width="1" opacity="0.3"/>
        <circle cx="60" cy="60" r="24" fill="none" stroke="var(--cyan)" stroke-width="1" opacity="0.18"/>
        <line x1="60" y1="12" x2="60" y2="108" stroke="var(--cyan)" stroke-width="0.5" opacity="0.25"/>
        <line x1="12" y1="60" x2="108" y2="60" stroke="var(--cyan)" stroke-width="0.5" opacity="0.25"/>
        <g>
          <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="4s" repeatCount="indefinite"/>
          <path d="M60 60 L60 12 A48 48 0 0 1 100 36 Z" fill="var(--cyan)" opacity="0.18"/>
        </g>
        <polyline class="fp-logo-hb" points="18,60 38,60 44,38 50,72 56,48 62,60 68,56 74,64 80,60 102,60" fill="none" stroke="var(--cyan-bright)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="60" cy="60" r="4" fill="var(--cyan)"/>
        <circle cx="60" cy="60" r="2" fill="var(--bg)"/>
        <circle cx="76" cy="38" r="3" fill="var(--pink)" opacity="0.95"/>
        <circle cx="76" cy="38" r="6" fill="none" stroke="var(--pink)" stroke-width="1.2" opacity="0.45">
          <animate attributeName="r" values="6;10;6" dur="1.8s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.45;0;0.45" dur="1.8s" repeatCount="indefinite"/>
        </circle>
      </svg></div>
          </div>
          <div className="fp-brand-text">
            <div className="fp-title">OUR&nbsp;HOME <span>// FINANCE OPS</span></div>
            <div className="fp-sub">Household Expense Command Center</div>
          </div>
        </div>
        <div className="fp-top-right">
          <div className="fp-tr-row fp-tr-row1">
            <button className={\`fp-privacy \${privacy ? "on" : ""}\`} onClick={() => setPrivacy(p => !p)}
                    title={privacy ? "Show amounts" : "Hide amounts (privacy mode)"}>
              {privacy ? <EyeOff size={14}/> : <Eye size={14}/>}
              <span>{privacy ? "Hidden" : "Visible"}</span>
            </button>
            <button className="fp-theme-toggle" onClick={() => setTheme(th => th === 'light' ? 'dark' : 'light')}
                    title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}>
              {theme === 'light' ? <Moon size={14}/> : <Sun size={14}/>}
            </button>
          </div>
          <div className="fp-tr-row fp-tr-row2">
            <div className="fp-datetime">
              <Calendar size={12} />
              <span className="fp-date">{clock.toLocaleDateString("en-GB", {weekday:'short', day:'2-digit', month:'short', year:'numeric'})}</span>
              <span className="fp-dt-sep">·</span>
              <span className="fp-time">{clock.toLocaleTimeString("en-GB")}</span>
            </div>
            <HelpButton onClick={openHelp} active={!!helpAnchor} />
          </div>
        </div>
      </header>
      <div className="fp-control">
        <nav className="fp-nav">
          <button className={"lg-fx " + (tab==="dashboard"?"on":"")} data-tab="dashboard" onClick={()=>setTab("dashboard")}>
            <LayoutDashboard size={15} /> <span className="fp-tab-long">Dashboard</span><span className="fp-tab-short">Dash</span>
          </button>
          <button className={"lg-fx " + (tab==="ledger"?"on":"")} data-tab="ledger" onClick={()=>setTab("ledger")}>
            <Table2 size={15} /> <span className="fp-tab-long">Monthly Entry</span><span className="fp-tab-short">Entry</span>
          </button>
          <button className={"lg-fx " + (tab==="installments"?"on":"")} data-tab="installments" onClick={()=>setTab("installments")}>
            <CreditCard size={15} /> <span className="fp-tab-long">Installments</span><span className="fp-tab-short">Bills</span>
          </button>
          <button className={"lg-fx " + (tab==="savings"?"on":"")} data-tab="savings" onClick={()=>setTab("savings")}>
            <Wallet size={15} /> <span className="fp-tab-long">Savings</span><span className="fp-tab-short">Save</span>
          </button>
          <button className={"lg-fx " + (tab==="car"?"on":"")} data-tab="car" onClick={()=>setTab("car")}>
            <Car size={15} /> <span className="fp-tab-long">Car</span><span className="fp-tab-short">Car</span>
          </button>
          <button className={"lg-fx " + (tab==="house"?"on":"")} data-tab="house" onClick={()=>setTab("house")}>
            <Home size={15} /> <span className="fp-tab-long">House</span><span className="fp-tab-short">House</span>
          </button>
        </nav>
        {(tab === "dashboard" || tab === "ledger") && (
          <>
          <div className="fp-years-mobile">
            <div className="fp-years-mobile-pill" style={{
              width: \`calc((100% - 6px) / \${years.length})\`,
              transform: \`translateX(\${years.indexOf(year) * 100}%)\`
            }} />
            {years.map(y => (
              <button key={y} className={year === y ? "on" : ""} onClick={() => setYear(y)}>
                FY{String(y).slice(2)}
              </button>
            ))}
          </div>
          <div className="fp-years">
            <YearPicker years={years} year={year} setYear={setYear} />
            <button className="fp-fy-new" title="Start a new year — carry forward your line items"
                    onClick={()=>setStartYearOpen(true)}>
              <Rocket size={12}/> Start FY{String(Math.max(...years, new Date().getFullYear())+1).slice(2)}
            </button>
          </div>
          </>
        )}
      </div>
      </div>
      {startYearOpen && ReactDOM.createPortal(
        <StartNewYearWizard boot={boot} years={years} onClose={()=>setStartYearOpen(false)}
                            onComplete={async (newYear) => {
                              setStartYearOpen(false);
                              const fresh = await api('/api/bootstrap');
                              setBoot(fresh);
                              setYear(newYear);
                              setEntryMonth(1);
                              setTab("ledger");
                            }} />,
        document.body
      )}
      {helpAnchor && <HelpPopover anchorRect={helpAnchor} onClose={closeHelp} />}
      {toast && ReactDOM.createPortal(
        <div className="fp-toast" role="status">
          <Check size={14}/>
          <span>{typeof toast === 'object' ? toast.message : toast}</span>
          {typeof toast === 'object' && toast.action && (
            <button className="fp-toast-action" onClick={(e) => {
              e.stopPropagation();
              toast.action.onClick();
              setToast(null);
            }}>{toast.action.label}</button>
          )}
          <button className="fp-toast-x" onClick={() => setToast(null)}><X size={11}/></button>
        </div>,
        document.body
      )}
      {tab==="dashboard" && <Dashboard summary={summary} year={year} boot={boot} onTabChange={setTab} />}
      {tab==="ledger"    && <Ledger boot={boot} monthData={monthData} entryMonth={entryMonth} setEntryMonth={setEntryMonth}
                                    year={year} saveExpense={saveExpense} saveIncome={saveIncome} addLineItem={addLineItem}
                                    deleteLineItem={deleteLineItem} renameLineItem={renameLineItem}
                                    editLineItem={editLineItem} duplicateLineItem={duplicateLineItem}
                                    moveLineItem={moveLineItem} renameCategory={renameCategory}
                                    moveCategory={moveCategory} deleteCategory={deleteCategory}
                                    reorderLineItems={reorderLineItems} reorderCategories={reorderCategories}
                                    reloadAfterShareChange={reloadAfterShareChange} />}
      {tab==="installments" && <Installments boot={boot} />}
      {tab==="car" && <LoanTab kind="car" monthData={monthData} />}
      {tab==="house" && <LoanTab kind="house" monthData={monthData} />}
      {tab==="savings" && (
        <ErrorBoundary fallback={(err, info) => (
          <main className="fp-main">
            <div className="card sv-empty" style={{textAlign:'left',padding:'24px 28px'}}>
              <h3 style={{color:'var(--red)',fontFamily:'Chakra Petch'}}>⚠️ Savings tab crashed</h3>
              <p style={{color:'var(--text-2)'}}>This means there's a bug in the Savings code. Share the error below with Claude.</p>
              <pre style={{background:'var(--bg-2)',padding:'12px',borderRadius:'8px',fontSize:'11px',color:'var(--pink-light)',overflowX:'auto',whiteSpace:'pre-wrap',marginTop:'10px'}}>
                {err?.toString()}
                {info?.componentStack ? '\\n\\nCOMPONENT STACK:' + info.componentStack : ''}
              </pre>
            </div>
          </main>
        )}>
          <Savings boot={boot} monthData={monthData} entryMonth={entryMonth} />
        </ErrorBoundary>
      )}
      <InstallPrompt />
      <footer className="fp-foot">
        <span className="fp-foot-credit">
          Powered by
          <svg className="fp-cf-logo" viewBox="0 0 256 116" xmlns="http://www.w3.org/2000/svg" aria-label="Cloudflare">
            <path fill="#F6821F" d="M202.956 49.21l-2.087-3.054-58.207-.34a1.135 1.135 0 01-.93-.482 1.149 1.149 0 01-.115-1.04 1.534 1.534 0 011.34-1.018L201.738 43c6.974-.318 14.524-5.967 17.166-12.85l3.354-8.737a2.026 2.026 0 00.092-1.156A37.965 37.965 0 00185.717 0c-19.794 0-36.563 12.769-42.585 30.527a18.62 18.62 0 00-13.116-3.642 18.685 18.685 0 00-16.225 22.978 25.974 25.974 0 00-9.057-1.598c-12.928 0-23.41 10.481-23.41 23.41 0 1.288.103 2.547.301 3.774a1.121 1.121 0 011.105.92h117.69a1.391 1.391 0 001.34-1.018l1.78-6.105c2.13-7.32-1.495-15.165-8.584-18.036z"/>
            <path fill="#FBAD41" d="M222.61 30.6h-1.073c-.241 0-.471.157-.553.398l-2.293 7.91c-2.131 7.32 1.494 15.164 8.584 18.035l12.378 5.085c.367.142.598.527.503.916l-.412 1.418c-2.131 7.32 1.494 15.164 8.584 18.036l8.187 3.365a.547.547 0 01.314.685l-.252.866c-.063.218-.265.367-.49.367H192.07a.554.554 0 01-.539-.413l-.61-2.122c-2.13-7.32-9.745-13.39-17.103-13.708l-49.65-.388a1.087 1.087 0 01-.93-.483 1.146 1.146 0 01-.116-1.038 1.532 1.532 0 011.34-1.018l58.207-.34c6.974-.318 14.524-5.968 17.167-12.85l3.353-8.737a2.024 2.024 0 00.092-1.155A37.965 37.965 0 00222.61 30.6z"/>
          </svg>
        </span>
      </footer>
    </div>
  );
}

function YearPicker({years, year, setYear}) {
  const sorted = [...years].sort((a, b) => a - b);
  const idx = sorted.indexOf(year);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < sorted.length - 1;

  return (
    <div className="fp-year-picker">
      <button className="fp-yp-arrow" disabled={!canPrev} onClick={()=>canPrev && setYear(sorted[idx-1])}
              title="Previous year">
        <ChevronLeft size={12}/>
      </button>
      <div className="fp-yp-current" title={\`Fiscal Year \${year}\`}>
        FY{String(year).slice(2)}
      </div>
      <button className="fp-yp-arrow" disabled={!canNext} onClick={()=>canNext && setYear(sorted[idx+1])}
              title="Next year">
        <ChevronRight size={12}/>
      </button>
    </div>
  );
}

function Boot() {
  return <div className="boot"><div className="boot-spinner"></div><div>SYNCING&nbsp;WITH&nbsp;D1</div></div>;
}

/* ===== NUMBER FORMATTING ON FOCUS ===== */
// Format a raw value for display (blurred state). Empty for null/zero/invalid.
function fmtMoney(v) {
  if (v === '' || v == null) return '';
  const n = Number(v);
  if (isNaN(n) || n === 0) return '';
  return n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Clean a typed string down to a numeric-ish value. Strips RM prefix, commas, garbage.
function parseMoney(s) {
  if (s === '' || s == null) return '';
  // Strip everything that's not a digit, period, or minus sign.
  // Uses character class (no backslash escapes) to survive outer template literal.
  const cleaned = String(s).replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return '';
  return cleaned;
}

// Drop-in replacement for <input type="number"> for currency amounts.
// Shows formatted value when blurred, raw digits when focused. Selects all on focus.
function FmtInput({value, onChange, onBlur, onKeyDown, placeholder, autoFocus, className, style, disabled, readOnly}) {
  const [display, setDisplay] = useState(() => fmtMoney(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDisplay(fmtMoney(value));
  }, [value, focused]);

  const handleFocus = (e) => {
    setFocused(true);
    const raw = value === '' || value == null || Number(value) === 0 ? '' : String(value);
    setDisplay(raw);
    const t = e.target;
    setTimeout(() => { try { t.select(); } catch(_) {} }, 0);
  };

  const handleBlur = (e) => {
    setFocused(false);
    const raw = parseMoney(display);
    setDisplay(fmtMoney(raw));
    if (onBlur) {
      const fakeEvent = Object.assign({}, e, { target: Object.assign({}, e.target, { value: raw }) });
      onBlur(fakeEvent);
    }
  };

  const handleChange = (e) => {
    setDisplay(e.target.value);
    if (onChange) {
      const cleaned = parseMoney(e.target.value);
      const fakeEvent = Object.assign({}, e, { target: Object.assign({}, e.target, { value: cleaned }) });
      onChange(fakeEvent);
    }
  };

  return (
    <input type="text" inputMode="decimal"
      value={display}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={className}
      style={style}
      disabled={disabled}
      readOnly={readOnly}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyDown={onKeyDown}
    />
  );
}

/* ===== LOADING SKELETONS ===== */
function Sk({w, h, style, br}) {
  const s = {width: w, height: h, ...(style||{})};
  if (br === 'circle') s.borderRadius = '50%';
  else if (br === 'pill') s.borderRadius = 999;
  else if (br !== undefined) s.borderRadius = br;
  return <span className="sk" style={s} />;
}

function LedgerSkeleton() {
  return (
    <main className="fp-main">
      <div className="fp-skel-card">
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
          <Sk w={14} h={14}/>
          <Sk w={160} h={13}/>
          <Sk w={56} h={16} br="pill" style={{marginLeft:'auto'}}/>
          <Sk w={92} h={22} br="pill"/>
        </div>
        <Sk w={70} h={9} style={{marginBottom:11}}/>
        {[1,2].map(i => (
          <div key={i} style={{display:'grid',gridTemplateColumns:'90px 1fr 16px 1fr 1fr',gap:12,alignItems:'center',padding:'12px 0',borderBottom:'1px solid var(--border-3)'}}>
            <Sk w={"70%"} h={22} br="pill"/>
            <div><Sk w={50} h={9} style={{display:'block',marginBottom:5}}/><Sk w={"100%"} h={26}/></div>
            <Sk w={14} h={14} br="circle"/>
            <div><Sk w={80} h={9} style={{display:'block',marginBottom:5}}/><Sk w={90} h={18}/></div>
            <div><Sk w={60} h={9} style={{display:'block',marginBottom:5}}/><Sk w={80} h={18}/></div>
          </div>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))',gap:12}}>
        {[3,2,3,2].map((rowCount, i) => (
          <div key={i} className="fp-skel-card" style={{marginBottom:0}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,paddingBottom:9,borderBottom:'1px solid var(--border-soft)'}}>
              <Sk w={22} h={22} br={7}/>
              <Sk w={90+i*15} h={12}/>
              <Sk w={56} h={16} br="pill" style={{marginLeft:'auto'}}/>
            </div>
            {Array.from({length: rowCount}).map((_, j) => (
              <div key={j} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0'}}>
                <Sk w={70+(j%3)*20} h={11}/>
                <Sk w={88} h={26} br={7}/>
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}

function InstallmentsSkeleton() {
  return (
    <main className="fp-main">
      <div className="ct-kpis" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}>
        {[1,2,3,4].map(i => (
          <div key={i} className="fp-skel-card" style={{marginBottom:0}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <Sk w={70} h={10}/>
              <Sk w={24} h={24} br={7}/>
            </div>
            <Sk w={100} h={24} style={{display:'block',marginBottom:6}}/>
            <Sk w={120} h={10}/>
          </div>
        ))}
      </div>
      <div className="fp-skel-card" style={{display:'flex',alignItems:'center',gap:10,marginTop:12,flexWrap:'wrap'}}>
        <Sk w={56} h={26} br="pill"/>
        <Sk w={64} h={26} br="pill"/>
        <Sk w={72} h={26} br="pill"/>
        <Sk w={56} h={26} br="pill"/>
        <Sk w={150} h={32} style={{marginLeft:'auto'}}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12,marginTop:12}}>
        {[1,2,3].map(i => (
          <div key={i} className="fp-skel-card" style={{marginBottom:0}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <Sk w={36} h={36} br={9}/>
              <div style={{flex:1,minWidth:0}}><Sk w={"80%"} h={13} style={{display:'block',marginBottom:5}}/><Sk w={"50%"} h={9}/></div>
              <Sk w={56} h={20} br="pill"/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
              <div><Sk w={36} h={8} style={{display:'block',marginBottom:4}}/><Sk w={70} h={14}/></div>
              <div><Sk w={50} h={8} style={{display:'block',marginBottom:4}}/><Sk w={60} h={14}/></div>
              <div><Sk w={44} h={8} style={{display:'block',marginBottom:4}}/><Sk w={50} h={14}/></div>
            </div>
            <Sk w={"100%"} h={8} style={{display:'block',borderRadius:4,marginBottom:9}}/>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end'}}>
              <div><Sk w={60} h={9} style={{display:'block',marginBottom:5}}/><Sk w={90} h={18}/></div>
              <Sk w={110} h={11}/>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function SavingsSkeleton() {
  return (
    <main className="fp-main sv-main">
      <div className="fp-skel-card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:14}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <Sk w={42} h={42} br="circle"/>
            <div><Sk w={130} h={14} style={{display:'block',marginBottom:5}}/><Sk w={90} h={10}/></div>
          </div>
          <div style={{textAlign:'right'}}>
            <Sk w={100} h={9} style={{display:'block',marginBottom:6}}/><Sk w={160} h={28} style={{display:'block'}}/>
          </div>
          <div style={{display:'flex',gap:8}}>
            <Sk w={90} h={32} br={8}/>
            <Sk w={90} h={32} br={8}/>
          </div>
        </div>
      </div>
      <div className="fp-skel-card">
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:14}}>
          <Sk w={170} h={13}/>
          <Sk w={70} h={16} br="pill"/>
        </div>
        <div style={{display:'flex',gap:11,alignItems:'center'}}>
          {[1,2,3,4].map(i => (
            <div key={i} style={{flex:1}}>
              <Sk w={"60%"} h={9} style={{display:'block',marginBottom:6}}/>
              <Sk w={"80%"} h={20} style={{display:'block',marginBottom:5}}/>
              <Sk w={"70%"} h={9}/>
            </div>
          ))}
        </div>
      </div>
      <div className="fp-skel-card">
        <Sk w={80} h={13} style={{display:'block',marginBottom:14}}/>
        {[1,2,3].map(i => (
          <div key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'1px solid var(--border-3)'}}>
            <Sk w={32} h={32} br={8}/>
            <div style={{flex:1,minWidth:0}}><Sk w={120+i*20} h={12} style={{display:'block',marginBottom:5}}/><Sk w={"70%"} h={9}/></div>
            <div style={{textAlign:'right'}}><Sk w={90} h={14} style={{display:'block',marginBottom:3}}/><Sk w={60} h={9}/></div>
          </div>
        ))}
      </div>
    </main>
  );
}

/* ===== HELP ICON + POPOVER + INLINE HELP ===== */
function HelpButton({onClick, active}) {
  return (
    <button className={\`fp-help-btn \${active ? "active" : ""}\`}
            onClick={onClick}
            aria-label="Open help"
            title="Help (press ? anywhere)">
      ?
    </button>
  );
}

function HelpPopover({anchorRect, onClose}) {
  const popRef = useRef(null);

  useEffect(() => {
    const click = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) && !e.target.closest('.fp-help-btn')) {
        onClose();
      }
    };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const items = [
    {ic: <LayoutDashboard size={14}/>, color:'var(--cyan)', bg:'rgba(34,211,238,0.13)', border:'var(--glow-cyan)',
     name:'What each tab does',
     desc:'Dashboard for year-over-year trends, Monthly Entry to log expenses, Installments for BNPL & big-ticket commitments, Savings for goals, Car & House for loan tracking with bank-app sync.'},
    {ic: <Wallet size={14}/>, color:'var(--purple-light)', bg:'rgba(167,139,250,0.13)', border:'var(--glow-purple)',
     name:'How the split works',
     desc:'Contribution = share % \u00d7 monthly expense. Surplus = salary \u2212 contribution. Take-Home = Surplus \u2212 personal items (credit card, subs).'},
    {ic: <Plus size={14}/>, color:'var(--teal)', bg:'rgba(94,234,212,0.13)', border:'#5eead455',
     name:'Adding & editing items',
     desc:'Floating + button (bottom-right) adds new line items. \u22ee on any item opens edit / duplicate / delete (delete has Undo).'},
    {ic: <Activity size={14}/>, color:'var(--pink-light)', bg:'rgba(244,114,182,0.13)', border:'var(--glow-pink)',
     name:'Installments tab',
     desc:'For BNPL or multi-month purchases (e.g. Joey sofa). Mark Paid each month keeps the schedule accurate; months-behind shows a red warning.'},
    {ic: <Home size={14}/>, color:'var(--orange)', bg:'rgba(255,149,84,0.13)', border:'#ff955455',
     name:'Car & House loan management',
     desc:'Update Snapshot to sync today\u2019s bank-app outstanding & total paid. Mark Paid records the monthly EMI with a 10s toast undo + persistent undo link on the hero card. Bank revised rate or EMI? Click Edit details on the calc-breakdown card.'},
    {ic: <Lock size={14}/>, color:'var(--amber-2)', bg:'rgba(251,191,36,0.13)', border:'#fbbf2455',
     name:'Privacy & Start New Year',
     desc:'"Hidden" toggle blurs every monetary value (Dashboard, Savings, Car/House) \u2014 hover any blurred figure to peek. "Start New Year" wizard each January carries forward your line items.'},
  ];

  const top = Math.min(anchorRect.bottom + 9, window.innerHeight - 510);
  const right = window.innerWidth - anchorRect.right;
  const isMobile = window.innerWidth <= 720;

  const inner = (
    <div ref={popRef} className={\`fp-help-pop \${isMobile ? "fp-help-pop-mobile" : ""}\`}
         style={isMobile ? undefined : {position:'fixed', top, right}}
         onClick={isMobile ? (e => e.stopPropagation()) : undefined}>
      {!isMobile && <div className="fp-help-arrow"></div>}
      <div className="fp-help-title">
        <span className="fp-help-title-ic">?</span>
        Quick help
      </div>
      {items.map((item, i) => (
        <div key={i} className="fp-help-item">
          <div className="fp-help-icon" style={{background: item.bg, color: item.color, border: \`1px solid \${item.border}\`}}>{item.ic}</div>
          <div style={{flex:1,minWidth:0}}>
            <div className="fp-help-name">{item.name}</div>
            <div className="fp-help-desc">{item.desc}</div>
          </div>
        </div>
      ))}
      <div className="fp-help-footer">Press<span className="fp-help-kbd">?</span>anywhere to open ·<span className="fp-help-kbd">Esc</span>to close</div>
    </div>
  );

  return ReactDOM.createPortal(
    isMobile
      ? <div className="fp-help-backdrop" onClick={onClose}>{inner}</div>
      : inner,
    document.body
  );
}

function InlineHelp({title, body}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 296));
      setPos({ top: r.bottom + 8, left });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span style={{display:'inline-flex',alignItems:'center'}}>
      <button ref={ref} className="fp-inline-help"
              onMouseEnter={show} onMouseLeave={hide}
              onFocus={show} onBlur={hide}
              tabIndex={0}
              aria-label={\`Help: \${title}\`}>?</button>
      {open && pos && ReactDOM.createPortal(
        <div className="fp-inline-pop" style={{position:'fixed', top: pos.top, left: pos.left}}>
          <div className="fp-inline-pop-title">{title}</div>
          <div className="fp-inline-pop-body">{body}</div>
        </div>,
        document.body
      )}
    </span>
  );
}

/* ===== MONTH COPY/PASTE ===== */
function CopyMonthButton({sourceMonthName, onClick}) {
  return (
    <button className="fp-copy-month-btn" onClick={onClick}
            title="Copy entries from another month into the current month">
      <Copy size={11}/>
      Copy from <span className="fp-copy-month-arrow">{sourceMonthName} →</span>
    </button>
  );
}

function CopyMonthModal({targetYear, targetMonth, onClose, onCopied}) {
  const prevMo = targetMonth === 1 ? 12 : targetMonth - 1;
  const prevYr = targetMonth === 1 ? targetYear - 1 : targetYear;
  const [srcYear, setSrcYear] = useState(prevYr);
  const [srcMonth, setSrcMonth] = useState(prevMo);
  const [mode, setMode] = useState('fill_empty');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (srcYear === targetYear && srcMonth === targetMonth) {
      setPreview({ items: [], error: "Pick a different month — can't copy onto itself." });
      return;
    }
    setPreview(null);
    Promise.all([
      api(\`/api/entries?year=\${srcYear}&month=\${srcMonth}\`),
      api(\`/api/entries?year=\${targetYear}&month=\${targetMonth}\`),
      api('/api/bootstrap')
    ]).then(([src, tgt, boot]) => {
      const srcMap = new Map();
      for (const e of (src.entries || [])) {
        if (e.amount > 0) srcMap.set(e.line_item_id, Number(e.amount));
      }
      const tgtFilled = new Set();
      for (const e of (tgt.entries || [])) {
        if (e.amount > 0) tgtFilled.add(e.line_item_id);
      }
      const liByName = new Map(boot.line_items.filter(li => li.active).map(li => [li.id, li.name]));
      const items = [];
      for (const [id, amt] of srcMap) {
        const name = liByName.get(id);
        if (!name) continue;
        items.push({ id, name, amount: amt, skip: tgtFilled.has(id) });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      setPreview({ items });
    }).catch(e => setPreview({ items: [], error: String(e.message || e) }));
  }, [srcYear, srcMonth, targetYear, targetMonth]);

  const toCopy = preview ? preview.items.filter(it => mode === 'overwrite' || !it.skip) : [];
  const toSkip = preview ? preview.items.filter(it => mode === 'fill_empty' && it.skip) : [];

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/entries/copy', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({
          source_year: srcYear, source_month: srcMonth,
          target_year: targetYear, target_month: targetMonth,
          mode
        })
      });
      onCopied(r);
    } catch (e) {
      setBusy(false);
      alert('Copy failed: ' + e.message);
    }
  };

  const srcMonthName = MONTHS[srcMonth - 1];
  const tgtMonthName = MONTHS[targetMonth - 1];

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 480}}>
        <div className="ib-modal-head">
          <h3><Copy size={14}/> Copy month entries</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="cm-flow">
            <div className="cm-flow-box">
              <div className="cm-flow-label">FROM</div>
              <div className="cm-flow-month">{srcMonthName} {srcYear}</div>
              <div className="cm-month-sel">
                <select value={srcMonth} onChange={e => setSrcMonth(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={m} value={i+1}>{m}</option>)}
                </select>
                <select value={srcYear} onChange={e => setSrcYear(Number(e.target.value))}>
                  {[targetYear-2, targetYear-1, targetYear, targetYear+1].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>
            <span className="cm-flow-arrow">→</span>
            <div className="cm-flow-box target">
              <div className="cm-flow-label">TO</div>
              <div className="cm-flow-month">{tgtMonthName} {targetYear}</div>
              <div className="cm-current">current</div>
            </div>
          </div>

          <div className="cm-mode">
            <button className={\`cm-mode-opt \${mode === 'fill_empty' ? "on" : ""}\`}
                    onClick={() => setMode('fill_empty')} type="button">Fill empty only</button>
            <button className={\`cm-mode-opt \${mode === 'overwrite' ? "on" : ""}\`}
                    onClick={() => setMode('overwrite')} type="button">Overwrite all</button>
          </div>
          <div className="cm-mode-desc">
            {mode === 'fill_empty'
              ? <>Skips items in {tgtMonthName} that already have a value. <b>Recommended</b> — won't clobber existing data.</>
              : <>Replaces all matching items in {tgtMonthName} with values from {srcMonthName}. <b style={{color:'var(--amber)'}}>Use carefully.</b></>}
          </div>

          {!preview && <div className="cm-preview-empty">Loading preview…</div>}
          {preview && preview.error && <div className="cm-preview-empty" style={{color:'var(--amber)'}}>{preview.error}</div>}
          {preview && !preview.error && preview.items.length === 0 && (
            <div className="cm-preview-empty">No entries found in {srcMonthName} {srcYear}.</div>
          )}
          {preview && !preview.error && preview.items.length > 0 && (
            <div className="cm-preview">
              {preview.items.map(it => {
                const willSkip = mode === 'fill_empty' && it.skip;
                return (
                  <div key={it.id} className="cm-preview-row">
                    <span className="cm-preview-name">{it.name}</span>
                    <span className={\`cm-preview-amt \${willSkip ? "skip" : ""}\`}>
                      {rm(it.amount)}
                      {willSkip && <span className="cm-skip-label">already has value</span>}
                    </span>
                  </div>
                );
              })}
              <div className="cm-preview-stat">
                <span><b style={{color:'var(--cyan-bright)'}}>{toCopy.length}</b> items to copy</span>
                {mode === 'fill_empty' && toSkip.length > 0 && (
                  <span><b style={{color:'var(--text-faint)'}}>{toSkip.length}</b> skipped (already filled)</span>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="ib-btn-solid" onClick={submit}
                  disabled={busy || !preview || preview.error || toCopy.length === 0}>
            <Check size={13}/> {busy ? 'Copying…' : \`Copy \${toCopy.length} item\${toCopy.length === 1 ? '' : 's'}\`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClearMonthButton({onClick, disabled}) {
  return (
    <button className="fp-clear-month-btn" onClick={onClick} disabled={disabled}
            title={disabled ? "Nothing to clear this month" : "Set all entries for this month to empty"}>
      <Trash2 size={11}/> Clear month
    </button>
  );
}

function ClearMonthModal({year, month, monthData, lineItems, onClose, onCleared}) {
  const [busy, setBusy] = useState(false);

  // Items to clear: active line items with amount > 0 in current month
  const nameById = useMemo(() => new Map(lineItems.filter(li => li.active).map(li => [li.id, li.name])), [lineItems]);
  const items = useMemo(() => {
    const entries = (monthData && monthData.entries) || [];
    return entries
      .filter(e => e.amount > 0 && nameById.has(e.line_item_id))
      .map(e => ({ id: e.line_item_id, name: nameById.get(e.line_item_id), amount: Number(e.amount) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [monthData, nameById]);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/entries/clear', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ year, month })
      });
      onCleared(r);
    } catch (e) {
      setBusy(false);
      alert('Clear failed: ' + e.message);
    }
  };

  const monthName = MONTHS[month - 1];

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 480}}>
        <div className="ib-modal-head">
          <h3><Trash2 size={14}/> Clear month entries</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="cm-warn">
            <AlertTriangle size={13}/>
            <span>This will set <b>all {items.length} entries</b> in <b>{monthName} {year}</b> to empty (amount = 0). Income, personal items, and installments are <b style={{color:'var(--text-2)'}}>not affected</b>. You'll have <b>10 seconds to undo</b>.</span>
          </div>
          {items.length === 0 ? (
            <div className="cm-preview-empty">Nothing to clear — all entries in {monthName} {year} are already empty.</div>
          ) : (
            <div className="cm-clear-list">
              {items.map(it => (
                <div key={it.id} className="cm-clear-row">
                  <span className="cm-clear-name">{it.name}</span>
                  <span className="cm-clear-amt">{rm(it.amount)}</span>
                </div>
              ))}
              <div className="cm-clear-stat">
                Total: <b>{rm(items.reduce((s, it) => s + it.amount, 0))}</b> across <b>{items.length}</b> {items.length === 1 ? 'item' : 'items'}
              </div>
            </div>
          )}
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="ib-btn-danger" onClick={submit} disabled={busy || items.length === 0}>
            <Trash2 size={13}/> {busy ? 'Clearing…' : \`Clear \${items.length} item\${items.length === 1 ? '' : 's'}\`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===== EMBEDDED PHOTOS (data URIs) ===== */
const EMBEDDED_PHOTOS = {
  'car-x50': 'data:image/jpeg;base64,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',
  'house-luminari': 'data:image/jpeg;base64,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'
};

/* ===== LOAN TAB (Car / House) ===== */
function computeLoanStats(loan) {
  // Months elapsed since start (clamped to tenure)
  const now = new Date();
  const elapsedMonths = (now.getFullYear() - loan.start_year) * 12 + (now.getMonth() + 1 - loan.start_month) + 1;
  const monthsPaid = Math.max(0, Math.min(elapsedMonths, loan.tenure_months));
  const monthsRemaining = loan.tenure_months - monthsPaid;
  const emi = Number(loan.monthly_payment);
  const principal = Number(loan.principal);

  // Total cost derived directly from monthly × tenure (matches the bank reality)
  const totalRepayment = emi * loan.tenure_months;
  const totalInterest = totalRepayment - principal;

  if (loan.rate_type === 'flat') {
    // Flat rate (Malaysian Hire Purchase): principal + interest spread equally
    const principalPerMonth = principal / loan.tenure_months;
    const interestPerMonth = totalInterest / loan.tenure_months;
    const scheduledPaid = emi * monthsPaid;
    const scheduledPrincipalPaid = principalPerMonth * monthsPaid;
    const scheduledInterestPaid = interestPerMonth * monthsPaid;
    const scheduledOutstandingPrincipal = principal - scheduledPrincipalPaid;
    const scheduledRemainingTotal = emi * monthsRemaining;
    return {
      monthsPaid, monthsRemaining, emi, totalRepayment, totalInterest,
      principalPerMonth, interestPerMonth,
      scheduledPaid, scheduledPrincipalPaid, scheduledInterestPaid,
      scheduledOutstandingPrincipal, scheduledRemainingTotal
    };
  } else {
    // Reducing balance (housing loan): full amortization
    const monthlyRate = (loan.rate / 100) / 12;
    // Outstanding balance using the ACTUAL EMI (not the rate-derived theoretical EMI).
    // Standard amortization: bal = P*(1+r)^m - EMI*((1+r)^m - 1)/r
    const factorPaid = Math.pow(1 + monthlyRate, monthsPaid);
    let scheduledOutstandingPrincipal;
    if (monthsPaid === 0) {
      scheduledOutstandingPrincipal = principal;
    } else if (monthlyRate === 0) {
      scheduledOutstandingPrincipal = Math.max(0, principal - emi * monthsPaid);
    } else {
      scheduledOutstandingPrincipal = principal * factorPaid - emi * ((factorPaid - 1) / monthlyRate);
    }
    scheduledOutstandingPrincipal = Math.max(0, scheduledOutstandingPrincipal);
    const scheduledPrincipalPaid = principal - scheduledOutstandingPrincipal;
    const scheduledPaid = emi * monthsPaid;
    const scheduledInterestPaid = scheduledPaid - scheduledPrincipalPaid;
    const scheduledRemainingTotal = emi * monthsRemaining;
    // Per-month principal/interest split varies (early = mostly interest)
    return {
      monthsPaid, monthsRemaining, emi, totalRepayment, totalInterest,
      monthlyRate,
      scheduledPaid, scheduledPrincipalPaid, scheduledInterestPaid,
      scheduledOutstandingPrincipal, scheduledRemainingTotal
    };
  }
}

// ---- BANK_LOGOS: inline data URLs for known bank brands ----
const BANK_LOGOS = {
  "gx":   "data:image/jpeg;base64,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",
  "grab": "data:image/jpeg;base64,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"
};
function getBankLogo(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  // Match common variants: 'GX', 'GXBank', 'Grab', 'Grab Bank', etc.
  if (lower.indexOf('gx') !== -1) return BANK_LOGOS.gx;
  if (lower.indexOf('grab') !== -1) return BANK_LOGOS.grab;
  return null;
}

function getLoanPhoto(loan) {
  if (!loan.photo_url) return null;
  if (loan.photo_url.startsWith('embedded:')) {
    const key = loan.photo_url.slice('embedded:'.length);
    return EMBEDDED_PHOTOS[key] || null;
  }
  return loan.photo_url;
}

function ordinalSuffix(n) {
  if (n >= 11 && n <= 13) return 'th';
  const last = n % 10;
  return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
}

function NextPaymentWidget({loan, stats, onMarkPaid, busy}) {
  const dueDay = loan.due_day || 1;
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // Next due = loan_start + monthsPaid months, with day = dueDay
  // The (monthsPaid+1)-th payment falls on (start_month + monthsPaid) of the start_year
  const monthsPaid = (stats && stats.monthsPaid != null) ? stats.monthsPaid : 0;
  const startYearIdx = loan.start_year;
  const startMonthIdx0 = loan.start_month - 1; // 0-indexed JS month
  const totalMonthsFromStart = startMonthIdx0 + monthsPaid;
  const nextYear = startYearIdx + Math.floor(totalMonthsFromStart / 12);
  const nextMonth = totalMonthsFromStart % 12;
  const nextDate = new Date(nextYear, nextMonth, dueDay);

  const days = Math.round((nextDate - todayMid) / 86400000);

  // 5-state threshold: paid > 14d, scheduled 7-14d, soon 3-6d, urgent 0-2d, overdue < 0d
  let state;
  if (days < 0) state = 'overdue';
  else if (days <= 2) state = 'urgent';
  else if (days <= 6) state = 'soon';
  else if (days <= 14) state = 'scheduled';
  else state = 'paid';

  // Icon per state
  let Icon;
  if (state === 'paid') Icon = Check;
  else if (state === 'scheduled') Icon = Clock;
  else if (state === 'soon') Icon = AlertCircle;
  else if (state === 'urgent') Icon = AlertTriangle;
  else Icon = XCircle;

  // Status text per state
  const monthNames = MONTHS;
  // Last paid = the monthsPaid-th payment = start_month + (monthsPaid - 1) of start_year
  const lastPaidMonthIdx = startMonthIdx0 + monthsPaid - 1;
  const lastPaidMonthName = monthsPaid > 0 ? monthNames[((lastPaidMonthIdx % 12) + 12) % 12] : null;
  const nextMonthName = monthNames[nextMonth];

  let statusText;
  let dateText;
  if (state === 'paid') {
    statusText = lastPaidMonthName ? ('Paid ' + lastPaidMonthName) : 'Up to date';
    dateText = 'Next: ' + nextMonthName + ' ' + dueDay + ', ' + nextYear + ' (in ' + days + ' days)';
  } else if (state === 'overdue') {
    const lateDays = Math.abs(days);
    statusText = 'Overdue by ' + lateDays + (lateDays === 1 ? ' day' : ' days');
    dateText = 'Was due ' + nextMonthName + ' ' + dueDay + ', ' + nextYear;
  } else if (state === 'urgent') {
    statusText = days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : 'Due in ' + days + ' days';
    dateText = nextMonthName + ' ' + dueDay + ', ' + nextYear;
  } else {
    statusText = 'in ' + days + ' days';
    dateText = nextMonthName + ' ' + dueDay + ', ' + nextYear;
  }

  // Button: ghost style in paid state ("Mark next early"), filled style otherwise
  const btnClass = state === 'paid' ? 'ln-np-mark ghost' : 'ln-np-mark';
  const btnLabel = state === 'paid'
    ? ('Mark ' + nextMonthName + ' paid')
    : (busy ? 'Saving' + '\u2026' : 'Mark paid');

  return (
    <div className={'ln-np ' + state}>
      <div className="ln-np-ic"><Icon size={20}/></div>
      <div className="ln-np-mid">
        <div className="ln-np-label">Next Payment</div>
        <div className="ln-np-amt">{rm(loan.monthly_payment)}</div>
        <div className="ln-np-info">
          <span><b>{loan.bank || '\u2014'}</b></span>
          <span>{'\u00b7'} due <b>{dueDay}{ordinalSuffix(dueDay)}</b> each month</span>
        </div>
      </div>
      <div className="ln-np-right">
        <div className="ln-np-countdown">{statusText}</div>
        <div className="ln-np-date">{dateText}</div>
        <button className={btnClass} onClick={onMarkPaid} disabled={busy}
                title="One-tap: snapshot_paid += EMI, snapshot_date = today">
          <Check size={11}/> {state === 'paid' ? btnLabel : (busy ? 'Saving' + '\u2026' : 'Mark paid')}
        </button>
      </div>
    </div>
  );
}

function FxInfo({onClick, amber}) {
  return (
    <button type="button" className={'ln-fx-info' + (amber ? ' amber' : '')} onClick={onClick} title="What does this mean?">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    </button>
  );
}

function FormulaExplainer({kind, loan, stats, onClose}) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const isReducing = loan.rate_type === 'reducing';
  const isFlat = !isReducing;
  const yearsLabel = Math.round(loan.tenure_months / 12);
  const monthlyRatePct = (stats.monthlyRate * 100).toFixed(4);
  const impliedFlat = isFlat
    ? ((stats.totalInterest / Number(loan.principal) / (loan.tenure_months / 12)) * 100).toFixed(2)
    : null;
  const firstMonthInterest = isReducing
    ? Math.round(Number(loan.principal) * stats.monthlyRate)
    : null;

  // Content variant resolution
  let title, badge, plain, formulaText, formulaResult, vars, why, yours, amber;

  if (kind === 'emi' && isReducing) {
    amber = false;
    title = 'Monthly EMI';
    badge = 'reducing balance';
    plain = 'This formula finds the fixed monthly payment that pays off the loan exactly over the tenure. Interest is charged only on the remaining balance, so each month\u2019s split between interest and principal changes.';
    formulaText = 'P \u00d7 [ r(1+r)\u207f \u00f7 ((1+r)\u207f \u2212 1) ]';
    formulaResult = rm(stats.emi);
    vars = [
      { sym: 'P',  name: 'Loan principal',           val: rm(loan.principal) },
      { sym: 'r',  name: 'Monthly rate (' + Number(loan.rate).toFixed(2) + '% \u00f7 12)', val: monthlyRatePct + '%' },
      { sym: 'n',  name: 'Tenure (months)',          val: String(loan.tenure_months) }
    ];
    why = 'The factor (1+r)\u207f compounds monthly interest over n months. Solving for the constant payment where the balance reaches zero at month n gives this formula. The bank charges interest only on what you still owe.';
    yours = 'Early payments are mostly interest (roughly ' + rm(firstMonthInterest) + ' of ' + rm(stats.emi) + ' in month 1). As the balance shrinks, the interest portion shrinks and the principal portion grows. See the Amortization chart below for the visual.';
  }
  else if (kind === 'emi' && isFlat) {
    amber = true;
    title = 'Monthly EMI';
    badge = 'flat rate';
    plain = 'For flat-rate hire purchase, the EMI shown here matches your bank statement. For verification, the equivalent formula is (Principal + Total Interest) \u00f7 n.';
    formulaText = '(P + Total Interest) \u00f7 n';
    formulaResult = rm(stats.emi);
    vars = [
      { sym: 'P',              name: 'Loan principal',         val: rm(loan.principal) },
      { sym: 'Total Interest', name: 'P \u00d7 flat rate \u00d7 years', val: rm(stats.totalInterest) },
      { sym: 'n',              name: 'Tenure (months)',        val: String(loan.tenure_months) }
    ];
    why = 'Each month\u2019s payment is a constant split: ' + rm(Number(loan.principal) / loan.tenure_months) + ' toward principal + ' + rm(stats.totalInterest / loan.tenure_months) + ' toward profit. Unlike reducing-balance loans, the interest portion does not decrease over time \u2014 even though your remaining balance does.';
    yours = 'Every month for ' + yearsLabel + ' years: same RM amount, same split. The bank\u2019s displayed profit rate (' + Number(loan.rate).toFixed(2) + '%) is the EFFECTIVE rate. The IMPLIED FLAT rate is ' + impliedFlat + '% \u2014 they look different because they\u2019re computed differently, but both describe the same loan.';
  }
  else if (kind === 'interest' && isReducing) {
    amber = false;
    title = 'Lifetime Interest';
    badge = 'reducing balance';
    plain = 'The total interest you pay over the life of the loan is the sum of all monthly interest portions. It is not known upfront \u2014 it is derived from EMI \u00d7 tenure, minus the original principal.';
    formulaText = '(EMI \u00d7 n) \u2212 P';
    formulaResult = rm(stats.totalInterest);
    vars = [
      { sym: 'EMI', name: 'Fixed monthly payment', val: rm(stats.emi) },
      { sym: 'n',   name: 'Tenure (months)',       val: String(loan.tenure_months) },
      { sym: 'P',   name: 'Loan principal',        val: rm(loan.principal) }
    ];
    why = null;
    yours = 'You\u2019ll repay ' + rm(stats.totalRepayment) + ' total over ' + yearsLabel + ' years. Of that, ' + rm(loan.principal) + ' is the original principal \u2014 the rest (' + rm(stats.totalInterest) + ') is interest. Paying extra each month reduces the principal faster, shrinking the interest you would otherwise owe in later months. See the What-If simulator.';
  }
  else {
    // kind === 'interest' && isFlat
    amber = true;
    title = 'Total Interest';
    badge = 'flat rate';
    plain = 'Flat-rate interest is known the day you sign the loan. It equals Total Repayment minus the original Principal \u2014 a fixed amount regardless of when you settle.';
    formulaText = 'Total Repayment \u2212 Principal';
    formulaResult = rm(stats.totalInterest);
    vars = [
      { sym: 'Total Repayment', name: 'EMI \u00d7 n',          val: rm(stats.totalRepayment) },
      { sym: 'Principal',       name: 'Original loan amount', val: rm(loan.principal) }
    ];
    why = 'Banks compute the total profit upfront for flat-rate hire-purchase loans. The implied flat rate works out to ' + impliedFlat + '% p.a. The bank typically displays an EFFECTIVE rate (' + Number(loan.rate).toFixed(2) + '%) which is higher \u2014 it converts the flat math into a reducing-balance-equivalent for comparison shopping.';
    yours = 'Total profit ' + rm(stats.totalInterest) + ' divided across ' + loan.tenure_months + ' months = ' + rm(stats.totalInterest / loan.tenure_months) + ' interest each month, every month. If you settle early, Bank Negara typically mandates an ibra\u2019 rebate (~80%) on the UNREDEEMED profit portion \u2014 worth asking the bank about.';
  }

  return ReactDOM.createPortal(
    <div className="ln-fx-overlay" onClick={onClose}>
      <div className={'ln-fx-pop' + (amber ? ' amber' : '')} onClick={e => e.stopPropagation()}>
        <div className="ln-fx-h">
          <div className={'ln-fx-h-ic' + (amber ? ' amber' : '')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1v6m0 6v6"/>
              <path d="m4.22 4.22 4.24 4.24m6.36 6.36 4.24 4.24"/>
              <path d="M1 12h6m6 0h6"/>
            </svg>
          </div>
          <div className="ln-fx-h-title">{title}<span className={'badge' + (amber ? ' amber' : '')}>{badge}</span></div>
          <button className="ln-fx-h-x" onClick={onClose} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="ln-fx-body">
          <div className="ln-fx-section">
            <div className="ln-fx-section-h"><span className="dot"></span>Plain English</div>
            <p>{plain}</p>
          </div>
          <div className="ln-fx-section">
            <div className="ln-fx-section-h"><span className="dot"></span>The formula</div>
            <div className={'ln-fx-formula-block' + (amber ? ' amber' : '')}>
              <span>{formulaText}</span>
              <span className="arrow">\u2192</span>
              <b>{formulaResult}</b>
            </div>
          </div>
          <div className="ln-fx-section">
            <div className="ln-fx-section-h amber"><span className="dot"></span>Variables</div>
            <div className="ln-fx-vars">
              {vars.map((v, i) => (
                <div key={i} className="ln-fx-var">
                  <span className="v-sym">{v.sym}</span>
                  <span className="v-name">{v.name}</span>
                  <span className="v-val">{v.val}</span>
                </div>
              ))}
            </div>
          </div>
          {why && (
            <div className="ln-fx-section">
              <div className="ln-fx-section-h purple"><span className="dot"></span>Why it works</div>
              <p>{why}</p>
            </div>
          )}
          <div className="ln-fx-section">
            <div className="ln-fx-section-h teal"><span className="dot"></span>Your loan</div>
            <p>{yours}</p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function LoanReconciliation({loan, stats}) {
  // Only render if there's a meaningful snapshot AND a meaningful gap
  const snapOut = (loan.snapshot_outstanding != null && Number(loan.snapshot_outstanding) > 0)
                    ? Number(loan.snapshot_outstanding) : null;
  const scheduledOut = stats.scheduledOutstandingPrincipal;
  if (snapOut == null || !scheduledOut || scheduledOut <= 0) return null;

  const gapPct = ((snapOut - scheduledOut) / scheduledOut) * 100;
  // Threshold: only show when |gap| >= 2%
  if (Math.abs(gapPct) < 2) return null;

  const isBehind = gapPct > 0;
  const gapAmount = Math.abs(snapOut - scheduledOut);
  const gapDirection = isBehind ? 'more' : 'less';
  const isReducing = loan.rate_type === 'reducing';
  const startLabel = MONTHS[((loan.start_month || 1) - 1)].slice(0,3) + ' ' + loan.start_year;

  // Reasons list — context-aware based on rate type
  let reasons;
  if (isReducing) {
    reasons = isBehind ? [
      <span key="r1">Interest rate may have changed since loan start in <b>{startLabel}</b> (BLR/BR revisions)</span>,
      <span key="r2">Other charges and fees may have accrued (visible on your bank statement)</span>,
      <span key="r3">Daily-rest vs monthly-rest interest calculation differences</span>,
      <span key="r4">Late-payment fees, if any, compound into the outstanding balance</span>
    ] : [
      <span key="r1">You\u2019ve made extra principal payments at some point</span>,
      <span key="r2">Rate has dropped since loan start (BLR/BR fell)</span>,
      <span key="r3">A lump-sum partial settlement was applied</span>,
      <span key="r4">One-off refund or rebate from the bank</span>
    ];
  } else {
    // Flat rate (car) — fewer rate-related reasons since rate is fixed
    reasons = isBehind ? [
      <span key="r1">Other charges or fees accrued on the bank statement</span>,
      <span key="r2">Late-payment fees, if any, compound into the outstanding balance</span>,
      <span key="r3">Different settlement-balance calculation by the bank</span>
    ] : [
      <span key="r1">You\u2019ve made extra principal payments at some point</span>,
      <span key="r2">A lump-sum partial settlement was applied with ibra\u2019 rebate</span>,
      <span key="r3">Bank applied a one-off rebate or refund</span>
    ];
  }

  const titleText = isBehind
    ? 'Bank shows '
    : 'You\u2019re ';
  const titleAmount = isBehind
    ? rm(Math.round(gapAmount)) + ' more'
    : rm(Math.round(gapAmount)) + ' ahead';
  const titleSuffix = isBehind
    ? ' than scheduled'
    : ' of schedule';

  const footText = isBehind
    ? 'What to do: nothing, unless the gap grows month over month. Trust the bank\u2019s snapshot for actual outstanding; use scheduled as a baseline.'
    : 'Implication: at this pace, your final payoff could come earlier than planned. Open the What-If simulator to estimate by how much.';

  const iconBehind = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="13"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
  const iconAhead = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );

  return (
    <div className={'ln-recon' + (isBehind ? '' : ' ahead')}>
      <div className="ln-recon-h">
        <div className="ln-recon-ic">{isBehind ? iconBehind : iconAhead}</div>
        <div className="ln-recon-h-body">
          <div className="ln-recon-title">{titleText}<b>{titleAmount}</b>{titleSuffix}</div>
          <div className="ln-recon-sub">
            Snapshot {rm(Math.round(snapOut))} {' \u00b7 '} Scheduled {rm(Math.round(scheduledOut))} {' \u00b7 \u0394 '}{Math.abs(gapPct).toFixed(1)}%
          </div>
        </div>
      </div>
      <div className="ln-recon-body">
        <p>{isBehind
          ? <>This isn\u2019t unusual. The portal\u2019s <b>scheduled outstanding</b> uses a textbook amortization formula \u2014 it assumes constant rate, monthly-rest, no fees, and every payment landing exactly on the due date. Banks compute interest with more variables.</>
          : <>Your bank shows a <b>lower</b> outstanding than the textbook formula predicts. That means you\u2019re paying down faster than the original schedule \u2014 usually a good thing.</>}
        </p>
        <div className="ln-recon-reasons">
          <div className="ln-recon-reasons-h">{isBehind ? 'Common reasons' : 'Likely reasons'}</div>
          <ul>
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
        <div className="ln-recon-foot">
          <b>{isBehind ? 'What to do:' : 'Implication:'}</b> {isBehind
            ? ' nothing, unless the gap grows month over month. Trust the bank\u2019s snapshot for actual outstanding; use scheduled as a baseline.'
            : ' at this pace, your final payoff could come earlier than planned. Open the What-If simulator to estimate by how much.'}
        </div>
      </div>
    </div>
  );
}

function EditLoanModal({loan, onClose, onSaved}) {
  const [name, setName] = useState(loan.name || '');
  const [bank, setBank] = useState(loan.bank || '');
  const [acctNo, setAcctNo] = useState(loan.account_no ? String(loan.account_no) : '');
  const [emi, setEmi] = useState(loan.monthly_payment != null ? String(loan.monthly_payment) : '');
  const [rate, setRate] = useState(loan.rate != null ? String(loan.rate) : '');
  const [rateType, setRateType] = useState(loan.rate_type || 'reducing');
  const [tenure, setTenure] = useState(loan.tenure_months != null ? String(loan.tenure_months) : '');
  const [startYear, setStartYear] = useState(loan.start_year != null ? String(loan.start_year) : '');
  const [startMonth, setStartMonth] = useState(loan.start_month != null ? String(loan.start_month) : '');
  const [dueDay, setDueDay] = useState(loan.due_day != null ? String(loan.due_day) : '');
  const [notes, setNotes] = useState(loan.notes || '');
  const [busy, setBusy] = useState(false);

  // Track dirty fields by comparing parsed values to originals
  const changedFields = [];
  if (name !== (loan.name || '')) changedFields.push('name');
  if (bank !== (loan.bank || '')) changedFields.push('bank');
  if (acctNo !== (loan.account_no ? String(loan.account_no) : '')) changedFields.push('account');
  const emiParsed = parseMoney(emi);
  if (emiParsed !== String(loan.monthly_payment || '')) changedFields.push('EMI');
  const rateParsed = parseMoney(rate);
  if (rateParsed !== String(loan.rate || '')) changedFields.push('rate');
  if (rateType !== (loan.rate_type || 'reducing')) changedFields.push('rate type');
  const tenureParsed = parseMoney(tenure);
  if (tenureParsed !== String(loan.tenure_months || '')) changedFields.push('tenure');
  if (startYear !== String(loan.start_year || '')) changedFields.push('start year');
  if (startMonth !== String(loan.start_month || '')) changedFields.push('start month');
  if (dueDay !== String(loan.due_day || '')) changedFields.push('due day');
  if (notes !== (loan.notes || '')) changedFields.push('notes');

  const isDirty = changedFields.length > 0;

  const buildStatus = () => {
    if (!isDirty) return 'No changes yet';
    const count = changedFields.length;
    return count + ' change' + (count > 1 ? 's' : '') + ' ' + '\u00b7' + ' ' + changedFields.join(', ');
  };

  const save = async () => {
    if (!isDirty || busy) return;
    setBusy(true);

    // Build patch body with only changed fields
    const body = {};
    const changes = [];
    if (name !== (loan.name || '')) { body.name = name; }
    if (bank !== (loan.bank || '')) { body.bank = bank; }
    if (acctNo !== (loan.account_no ? String(loan.account_no) : '')) { body.account_no = acctNo; }
    const emiNum = emiParsed === '' ? null : Number(emiParsed);
    if (emiNum != null && emiNum !== Number(loan.monthly_payment)) {
      body.monthly_payment = emiNum;
      changes.push('EMI ' + rm(loan.monthly_payment) + ' ' + '\u2192' + ' ' + rm(emiNum));
    }
    const rateNum = rateParsed === '' ? null : Number(rateParsed);
    if (rateNum != null && rateNum !== Number(loan.rate)) {
      body.rate = rateNum;
      changes.push('rate ' + Number(loan.rate).toFixed(2) + '%' + ' ' + '\u2192' + ' ' + rateNum.toFixed(2) + '%');
    }
    if (rateType !== (loan.rate_type || 'reducing')) { body.rate_type = rateType; }
    const tenureNum = tenureParsed === '' ? null : parseInt(tenureParsed, 10);
    if (tenureNum != null && tenureNum !== Number(loan.tenure_months)) { body.tenure_months = tenureNum; }
    const startYearNum = startYear === '' ? null : parseInt(startYear, 10);
    if (startYearNum != null && startYearNum !== Number(loan.start_year)) { body.start_year = startYearNum; }
    const startMonthNum = startMonth === '' ? null : parseInt(startMonth, 10);
    if (startMonthNum != null && startMonthNum !== Number(loan.start_month)) { body.start_month = startMonthNum; }
    const dueDayNum = dueDay === '' ? null : parseInt(dueDay, 10);
    if (dueDayNum != null && dueDayNum !== Number(loan.due_day)) {
      // Clamp 1..28
      const clamped = Math.max(1, Math.min(28, dueDayNum));
      body.due_day = clamped;
    }
    if (notes !== (loan.notes || '')) { body.notes = notes; }

    if (Object.keys(body).length === 0) { setBusy(false); return; }

    try {
      await api('/api/loans/' + loan.id, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      if (window.__mam_toast) {
        const summary = changes.length > 0
          ? 'Loan updated' + ' ' + '\u00b7' + ' ' + changes.join(', ')
          : 'Loan details updated';
        window.__mam_toast(summary);
      }
      onSaved();
      onClose();
    } catch (e) {
      alert('Failed to update: ' + e.message);
      setBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="ln-modal-overlay" onClick={onClose}>
      <div className="ln-modal" onClick={e => e.stopPropagation()} style={{maxWidth:560}}>
        <div className="ln-modal-h">
          <div>
            <div className="ln-modal-title">Edit loan details</div>
            <div className="ln-modal-sub">{loan.name}{loan.bank ? ' ' + '\u00b7' + ' ' + loan.bank : ''}</div>
          </div>
          <button className="ln-modal-x" onClick={onClose}><X size={14}/></button>
        </div>

        <div className="ln-modal-scroll">
        <div className="ln-form-grid">
          <div>
            <div className="ln-edit-label">Name</div>
            <div className="ln-field-i">
              <input type="text" value={name} onChange={e => setName(e.target.value)} />
            </div>
          </div>

          <div className="ln-form-row two">
            <div>
              <div className="ln-edit-label">Bank</div>
              <div className="ln-field-i">
                <input type="text" value={bank} onChange={e => setBank(e.target.value)} />
              </div>
            </div>
            <div>
              <div className="ln-edit-label">Account no.</div>
              <div className="ln-field-i">
                <input type="text" value={acctNo} onChange={e => setAcctNo(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="ln-form-row two">
            <div>
              <div className="ln-edit-label">Monthly EMI</div>
              <div className="ln-field-i">
                <span className="pfx">RM</span>
                <input type="text" inputMode="decimal" value={emi} onChange={e => setEmi(e.target.value)} onFocus={e => e.target.select()} />
              </div>
            </div>
            <div>
              <div className="ln-edit-label">Interest rate</div>
              <div className="ln-field-i">
                <input type="text" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} onFocus={e => e.target.select()} />
                <span className="sfx">% p.a.</span>
              </div>
            </div>
          </div>

          <div className="ln-form-row two">
            <div>
              <div className="ln-edit-label">Rate type</div>
              <div className="ln-seg-control">
                <button className={rateType === 'flat' ? 'active' : ''} onClick={() => setRateType('flat')} type="button">Flat</button>
                <button className={rateType === 'reducing' ? 'active' : ''} onClick={() => setRateType('reducing')} type="button">Reducing</button>
              </div>
            </div>
            <div>
              <div className="ln-edit-label">Tenure</div>
              <div className="ln-field-i">
                <input type="text" inputMode="numeric" value={tenure} onChange={e => setTenure(e.target.value)} onFocus={e => e.target.select()} />
                <span className="sfx">{tenure ? 'months · ' + (Number(parseMoney(tenure) || 0) / 12).toFixed(Number(parseMoney(tenure) || 0) % 12 === 0 ? 0 : 1) + ' yr' : 'months'}</span>
              </div>
            </div>
          </div>

          <div className="ln-form-row three">
            <div>
              <div className="ln-edit-label">Start year</div>
              <div className="ln-field-i">
                <input type="text" inputMode="numeric" value={startYear} onChange={e => setStartYear(e.target.value)} onFocus={e => e.target.select()} />
              </div>
            </div>
            <div>
              <div className="ln-edit-label">Start month</div>
              <div className="ln-field-i">
                <select value={startMonth} onChange={e => setStartMonth(e.target.value)}>
                  {MONTHS.map((m, i) => <option key={i+1} value={String(i+1)}>{m}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="ln-edit-label">Due day <span className="help">(1-28)</span></div>
              <div className="ln-field-i">
                <input type="text" inputMode="numeric" value={dueDay} onChange={e => setDueDay(e.target.value)} onFocus={e => e.target.select()} />
              </div>
            </div>
          </div>

          <div>
            <div className="ln-edit-label">Notes <span className="help">- optional</span></div>
            <div className="ln-field-i">
              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g., Restructured 2024 from 4.10% to 4.30% after BLR revision" />
            </div>
          </div>
        </div>

        <div className="ln-locked-section">
          <div className="ln-locked-l">
            <Lock size={10}/> Locked (historical facts)
          </div>
          <div className="ln-locked-grid">
            <div className="ln-locked-item">
              <span>Purchase Price</span>{rm(loan.purchase_price)}
            </div>
            <div className="ln-locked-item">
              <span>Down Payment</span>{rm(loan.down_payment)}
            </div>
            <div className="ln-locked-item">
              <span>Principal</span>{rm(loan.principal)}
            </div>
          </div>
        </div>
        </div>

        <div className="ln-modal-foot">
          <div className={'ln-modal-status' + (isDirty ? ' changed' : '')}>{buildStatus()}</div>
          <div className="ln-modal-actions">
            <button className="ln-btn ln-btn-secondary" onClick={onClose} type="button">Cancel</button>
            <button className="ln-btn ln-btn-primary" onClick={save} disabled={!isDirty || busy} type="button">
              <Check size={13}/> {busy ? 'Saving' + '\u2026' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function UpdateSnapshotModal({loan, onClose, onSaved}) {
  const today = new Date().toISOString().slice(0, 10);
  const paidRef = useRef(null);
  const outRef = useRef(null);
  const dateRef = useRef(null);
  const [busy, setBusy] = useState(false);

  // Initial visible values (only show non-zero snapshot)
  const initPaid = (loan.snapshot_paid && Number(loan.snapshot_paid) !== 0) ? String(loan.snapshot_paid) : '';
  const initOut = (loan.snapshot_outstanding && Number(loan.snapshot_outstanding) !== 0) ? String(loan.snapshot_outstanding) : '';
  const initDate = loan.snapshot_date || today;

  const quickFill = () => {
    const prevPaid = Number(loan.snapshot_paid) || 0;
    const prevOut = (Number(loan.snapshot_outstanding) && Number(loan.snapshot_outstanding) !== 0)
                      ? Number(loan.snapshot_outstanding) : Number(loan.principal);
    const newPaid = prevPaid + Number(loan.monthly_payment);
    let scheduledPrincipal;
    if (loan.rate_type === 'flat') {
      scheduledPrincipal = Number(loan.principal) / loan.tenure_months;
    } else {
      const r = (loan.rate / 100) / 12;
      scheduledPrincipal = Number(loan.monthly_payment) - prevOut * r;
    }
    const newOut = Math.max(0, prevOut - scheduledPrincipal);
    if (paidRef.current) paidRef.current.value = (Math.round(newPaid * 100) / 100).toFixed(2);
    if (outRef.current) outRef.current.value = (Math.round(newOut * 100) / 100).toFixed(2);
    if (dateRef.current) dateRef.current.value = today;
  };

  const save = async () => {
    if (busy) return;
    const paidRaw = paidRef.current ? paidRef.current.value : '';
    const outRaw = outRef.current ? outRef.current.value : '';
    const dateVal = dateRef.current ? dateRef.current.value : today;
    const pp = parseMoney(paidRaw);
    const op = parseMoney(outRaw);
    const paidNum = pp === '' ? 0 : Number(pp);
    const outNum = op === '' ? 0 : Number(op);

    // Safeguard: don't silently save zeros
    if (paidNum === 0 && outNum === 0) {
      const ok = confirm('Both Total Paid and Outstanding are 0. Clear the snapshot? Click Cancel to go back and enter the values from your bank app.');
      if (!ok) return;
    }

    setBusy(true);
    try {
      await api(\`/api/loans/\${loan.id}\`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          snapshot_paid: paidNum,
          snapshot_outstanding: outNum,
          snapshot_date: dateVal
        })
      });
      if (window.__mam_toast) {
        const undoFn = async () => {
          try {
            await api('/api/loans/' + loan.id + '/undo', { method: 'POST' });
            if (window.__mam_toast) window.__mam_toast('Undone' + ' ' + '\u00b7' + ' previous snapshot restored');
            onSaved();
          } catch (e) {
            if (window.__mam_toast) window.__mam_toast('Undo failed' + ' ' + '\u00b7' + ' ' + (e && e.message ? e.message : 'error'));
          }
        };
        window.__mam_toast('Snapshot saved' + ' ' + '\u00b7' + ' paid ' + rm(paidNum) + ' ' + '\u00b7' + ' outstanding ' + rm(outNum), {
          duration: 10000,
          action: { label: 'Undo', onClick: undoFn }
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      alert('Failed to save: ' + e.message);
      setBusy(false);
    }
  };

  const hasPrev = loan.snapshot_date && (Number(loan.snapshot_paid) !== 0 || Number(loan.snapshot_outstanding) !== 0);

  return ReactDOM.createPortal(
    <div className="ln-modal-overlay" onClick={onClose}>
      <div className="ln-modal" onClick={e => e.stopPropagation()}>
        <div className="ln-modal-h">
          <div>
            <div className="ln-modal-title">Update snapshot</div>
            <div className="ln-modal-sub">{loan.bank}{loan.account_no ? ' · ' + loan.account_no : ''}</div>
          </div>
          <button className="ln-modal-x" onClick={onClose}><X size={14}/></button>
        </div>

        {hasPrev && (
          <div className="ln-prev-block">
            <div className="ln-prev-l">Previous snapshot · {loan.snapshot_date}</div>
            <div className="ln-prev-r"><span>Total Paid</span><span>{rm(loan.snapshot_paid)}</span></div>
            <div className="ln-prev-r"><span>Outstanding</span><span>{rm(loan.snapshot_outstanding)}</span></div>
          </div>
        )}

        <button className="ln-qa-strip" onClick={quickFill} type="button">
          <div className="ln-qa-ic"><Check size={13}/></div>
          <div className="ln-qa-body">
            <b>Quick: I just paid this month's EMI</b>
            <span>Auto-fills: paid += {rm(loan.monthly_payment)} · date = today</span>
          </div>
          <span className="ln-qa-arrow">→</span>
        </button>

        <div className="ln-field">
          <label className="ln-field-l">Total Paid <em>cumulative from bank app</em></label>
          <div className="ln-field-i"><span className="pfx">RM</span>
            <input type="text" inputMode="decimal" ref={paidRef} defaultValue={initPaid}
                   onFocus={e => e.target.select()} placeholder="0.00" />
          </div>
        </div>
        <div className="ln-field">
          <label className="ln-field-l">Outstanding Settlement</label>
          <div className="ln-field-i"><span className="pfx">RM</span>
            <input type="text" inputMode="decimal" ref={outRef} defaultValue={initOut}
                   onFocus={e => e.target.select()} placeholder="0.00" />
          </div>
        </div>
        <div className="ln-field">
          <label className="ln-field-l">As of date</label>
          <div className="ln-field-i">
            <input type="date" ref={dateRef} defaultValue={initDate} max={today} />
          </div>
        </div>

        <div className="ln-modal-actions">
          <button className="ln-btn-c" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="ln-btn-s" onClick={save} disabled={busy}>
            <Check size={12}/> {busy ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function WhatIfCalculator({loan, stats}) {
  const [extra, setExtra] = useState(200);

  const result = useMemo(() => {
    const principalOutstanding = stats.scheduledOutstandingPrincipal;
    const monthsLeft = stats.monthsRemaining;
    const emi = stats.emi;
    if (extra <= 0 || monthsLeft <= 0) {
      return {newMonths: monthsLeft, monthsSaved: 0, interestSaved: 0, stillPay: emi * monthsLeft};
    }
    if (loan.rate_type === 'flat') {
      const newP = stats.principalPerMonth + extra;
      const newMonths = Math.max(1, Math.ceil(principalOutstanding / newP));
      const monthsSaved = monthsLeft - newMonths;
      const interestSaved = Math.max(0, monthsSaved * stats.interestPerMonth * 0.8);
      const stillPay = (emi + extra) * newMonths;
      return {newMonths, monthsSaved, interestSaved, stillPay};
    } else {
      let bal = principalOutstanding, totIx = 0, months = 0;
      const r = stats.monthlyRate;
      const newEMI = emi + extra;
      while (bal > 0.01 && months < 1500) {
        const ix = bal * r;
        const pp = Math.min(newEMI - ix, bal);
        if (pp <= 0) break;
        bal -= pp; totIx += ix; months++;
      }
      const monthsSaved = monthsLeft - months;
      const origInterest = emi * monthsLeft - principalOutstanding;
      const interestSaved = Math.max(0, origInterest - totIx);
      const stillPay = newEMI * months;
      return {newMonths: months, monthsSaved, interestSaved, stillPay};
    }
  }, [loan, stats, extra]);

  const today = new Date();
  const newPayoff = new Date(today);
  newPayoff.setMonth(newPayoff.getMonth() + result.newMonths);
  const origPayoff = new Date(today);
  origPayoff.setMonth(origPayoff.getMonth() + stats.monthsRemaining);
  const fmtPo = d => \`\${MONTHS[d.getMonth()]} \${d.getFullYear()}\`;

  const origTotal = stats.emi * stats.monthsRemaining;
  const savedPct = origTotal > 0 ? Math.min(100, (result.interestSaved / origTotal) * 100) : 0;
  const slPct = Math.min(100, (extra / 2000) * 100);

  return (
    <div className="ln-card">
      <div className="ln-card-title">
        <Target size={14} color="var(--purple-light)"/>
        Extra payment simulator
        <span className="ln-tag">{loan.rate_type === 'flat' ? "flat rate · approximate ibra\u2019" : 'reducing balance · exact'}</span>
      </div>

      <div className="ln-sl-row">
        <span>Pay extra per month →</span>
        <span className="ln-sl-val">{rm(extra)}</span>
      </div>
      <input type="range" className="ln-sl" min="0" max="2000" step="50" value={extra}
             onChange={e => setExtra(+e.target.value)}
             style={{backgroundSize: 'calc(' + slPct + '% - ' + (slPct/100*18) + 'px + 9px) 100%'}} />
      <div className="ln-sl-ticks">
        <span>0</span><span>400</span><span>800</span><span>1,200</span><span>1,600</span><span>2,000</span>
      </div>

      <div className="ln-results">
        <div className="ln-res cyan">
          <div className="ln-res-label">Months saved</div>
          <div className="ln-res-val">{result.monthsSaved}</div>
          <div className="ln-res-sub"><b>{stats.monthsRemaining} → {result.newMonths}</b> months</div>
        </div>
        <div className="ln-res teal">
          <div className="ln-res-label">Interest saved</div>
          <div className="ln-res-val money">{rm(result.interestSaved)}</div>
          <div className="ln-res-sub">{loan.rate_type === 'flat' ? "approx · ibra\u2019 ~80% applied" : 'exact · compounded'}</div>
        </div>
        <div className="ln-res purple">
          <div className="ln-res-label">New payoff</div>
          <div className="ln-res-val">{fmtPo(newPayoff)}</div>
          <div className="ln-res-sub">from <b>{fmtPo(origPayoff)}</b></div>
        </div>
      </div>

      <div className="ln-impact-bar">
        <div className="ln-impact-orig" style={{width: (100 - savedPct) + '%'}}></div>
        <div className="ln-impact-saved" style={{width: savedPct + '%'}}></div>
      </div>
      <div className="ln-impact-labels">
        <span>What you'd still pay: <b>{rm(result.stillPay)}</b></span>
        <span>You save: <b style={{color:'var(--teal)'}}>{rm(result.interestSaved)}</b></span>
      </div>

      <div className="ln-note">
        {loan.rate_type === 'flat'
          ? <><b>Flat rate (Hire Purchase):</b> extra payments shorten the schedule; interest savings depend on Maybank's ibra' (rebate) on unearned profit \u2014 typically ~80%. Actual rebate may vary.</>
          : <><b>Reducing balance:</b> extra payments reduce the principal balance immediately, so future interest is computed on a smaller base. Compound effect = massive savings on long mortgages.</>}
      </div>
    </div>
  );
}

function LoanTab({kind, monthData}) {
  const [loan, setLoan] = useState(null);
  const [err, setErr] = useState(null);
  const [snapOpen, setSnapOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [markBusy, setMarkBusy] = useState(false);

  const reload = useCallback(() => {
    api('/api/loans').then(r => {
      const found = (r.loans || []).find(l => l.kind === kind);
      setLoan(found || null);
    }).catch(e => setErr(String(e.message || e)));
  }, [kind]);

  useEffect(() => { reload(); }, [reload]);

  // Shared: undo the most recent snapshot change for this loan
  const performUndo = async () => {
    if (!loan) return;
    try {
      await api('/api/loans/' + loan.id + '/undo', { method: 'POST' });
      if (window.__mam_toast) window.__mam_toast('Undone' + ' ' + '\u00b7' + ' previous snapshot restored');
      reload();
    } catch (e) {
      if (window.__mam_toast) window.__mam_toast('Undo failed' + ' ' + '\u00b7' + ' ' + (e && e.message ? e.message : 'unknown error'));
    }
  };

  const markPaid = async () => {
    if (!loan || markBusy) return;
    setMarkBusy(true);
    try {
      const prevPaid = Number(loan.snapshot_paid) || 0;
      const prevOut = Number(loan.snapshot_outstanding) || Number(loan.principal);
      const newPaid = prevPaid + Number(loan.monthly_payment);
      let scheduledPrincipal;
      if (loan.rate_type === 'flat') {
        scheduledPrincipal = Number(loan.principal) / loan.tenure_months;
      } else {
        const r = (loan.rate / 100) / 12;
        scheduledPrincipal = Number(loan.monthly_payment) - prevOut * r;
      }
      const newOut = Math.max(0, prevOut - scheduledPrincipal);
      const today = new Date().toISOString().slice(0, 10);
      await api('/api/loans/' + loan.id, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          snapshot_paid: Math.round(newPaid * 100) / 100,
          snapshot_outstanding: Math.round(newOut * 100) / 100,
          snapshot_date: today
        })
      });
      if (window.__mam_toast) {
        const monthName = MONTHS[new Date().getMonth()];
        window.__mam_toast('Marked ' + monthName + ' payment paid', {
          duration: 10000,
          action: { label: 'Undo', onClick: performUndo }
        });
      }
      reload();
    } catch (e) {
      alert('Failed to mark paid: ' + e.message);
    } finally {
      setMarkBusy(false);
    }
  };

  if (err) return <main className="ln-main"><div className="ln-card ln-empty">Couldn't load loans: {err}</div></main>;
  if (loan === null) return kind === 'car' ? <CarSkeleton/> : <HouseSkeleton/>;
  if (!loan) {
    const Icon = kind === 'car' ? Car : Home;
    return (
      <main className="ln-main">
        <div className="ln-card ln-empty">
          <Icon size={48}/>
          <h3 style={{margin:0,fontFamily:"'Chakra Petch'",fontSize:'16px',color:'var(--text-2)'}}>No {kind} loan yet</h3>
          <p style={{margin:0,fontSize:'12px',maxWidth:'400px'}}>Run the SQL migration to seed your {kind} loan, or add one via the D1 console.</p>
        </div>
      </main>
    );
  }

  const stats = computeLoanStats(loan);
  let meta = {};
  try { meta = loan.metadata ? JSON.parse(loan.metadata) : {}; } catch (_) {}

  return (
    <main className="ln-main">
      <NextPaymentWidget loan={loan} stats={stats} onMarkPaid={markPaid} busy={markBusy} />
      <LoanHero loan={loan} stats={stats} meta={meta} onUndo={performUndo} />
      <LoanReconciliation loan={loan} stats={stats} />
      <LoanStatsGrid loan={loan} stats={stats} />
      <LoanProgress loan={loan} stats={stats} />
      <LoanCalcBreakdown loan={loan} stats={stats} onEdit={() => setEditOpen(true)} />
      <LoanPaidBreakdown loan={loan} stats={stats} onUpdateSnapshot={() => setSnapOpen(true)} />
      <LoanAmortChart loan={loan} stats={stats} />
      <WhatIfCalculator loan={loan} stats={stats} />
      {snapOpen && <UpdateSnapshotModal loan={loan} onClose={() => setSnapOpen(false)} onSaved={reload} />}
      {editOpen && <EditLoanModal loan={loan} onClose={() => setEditOpen(false)} onSaved={reload} />}
    </main>
  );
}

function LoanHero({loan, stats, meta, onUndo}) {
  const photo = getLoanPhoto(loan);
  const colorHex = meta.color_hex || (loan.kind === 'car' ? '#f5a623' : 'var(--teal)');
  const heroClass = loan.kind === 'car' ? 'ln-hero car' : 'ln-hero house';

  // Per-field snapshot resolution: use a snapshot value when it's set and meaningful (> 0),
  // otherwise fall back to the formula. This way if the bank app only shows outstanding
  // (not total-paid), we still respect the outstanding snapshot.
  const snapOut = (loan.snapshot_outstanding != null && Number(loan.snapshot_outstanding) > 0)
                    ? Number(loan.snapshot_outstanding) : null;
  const snapPaid = (loan.snapshot_paid != null && Number(loan.snapshot_paid) > 0)
                     ? Number(loan.snapshot_paid) : null;
  const hasSnap = (snapOut != null || snapPaid != null) && loan.snapshot_date != null;
  const paid = snapPaid != null ? snapPaid : stats.scheduledPaid;
  const outstanding = snapOut != null ? snapOut : stats.scheduledOutstandingPrincipal;

  // Loan health: compare snapshot vs scheduled outstanding (only when snapshot exists)
  const scheduledOut = stats.scheduledOutstandingPrincipal;
  let healthState = null;
  let healthLabel = null;
  if (snapOut != null && scheduledOut > 0) {
    const gapPct = ((snapOut - scheduledOut) / scheduledOut) * 100;
    if (Math.abs(gapPct) < 2) {
      healthState = 'on-track';
      healthLabel = 'On track';
    } else if (gapPct > 0) {
      healthState = 'behind';
      healthLabel = 'Behind by ' + gapPct.toFixed(1) + '%';
    } else {
      healthState = 'ahead';
      healthLabel = 'Ahead by ' + Math.abs(gapPct).toFixed(1) + '%';
    }
  }
  const healthIconOk = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
  const healthIconAhead = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 17 9 11 13 15 21 7"/>
      <polyline points="14 7 21 7 21 14"/>
    </svg>
  );
  const healthIconBehind = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 9v3M12 16h.01"/>
    </svg>
  );
  const paidPct = (stats.monthsPaid / loan.tenure_months) * 100;

  return (
    <div className={heroClass}>
      <div className="ln-photo">
        {photo
          ? <img src={photo} alt={loan.name} />
          : <span className="ln-photo-placeholder">No photo yet</span>}
      </div>
      <div className="ln-hero-info">
        <div className="ln-hero-meta">
          <span>{meta.year && <>{meta.year} · </>}{meta.type || (loan.kind === 'car' ? 'Vehicle' : 'Property')}{meta.sqft && <> · {meta.sqft} sqft</>}</span>
          {healthState && (
            <span className={'ln-health ' + healthState}>
              {healthState === 'on-track' && healthIconOk}
              {healthState === 'ahead' && healthIconAhead}
              {healthState === 'behind' && healthIconBehind}
              {healthLabel}
            </span>
          )}
        </div>
        <h2 className="ln-hero-name">{loan.name}</h2>
        <div className="ln-hero-sub">
          {meta.color && <span><span className="ln-color-chip" style={{background: colorHex}}></span> {meta.color}</span>}
          {meta.registration && <span>· {meta.registration}</span>}
          {meta.unit && <span>· {meta.unit}</span>}
        </div>
        <div className="ln-hero-balance">
          <div className="ln-bal-block">
            <div className="ln-bal-label">Outstanding</div>
            <div className="ln-bal-val outstanding">{rm(outstanding)}</div>
            <div className="ln-bal-sub">of {rm(loan.principal)} principal</div>
            {(hasSnap || loan.prev_snapshot_paid != null) && (
              <div className="ln-snapshot-row">
                {hasSnap && <div className="ln-snapshot-tag">bank snapshot · {loan.snapshot_date}</div>}
                {loan.prev_snapshot_paid != null && (
                  <button className="ln-undo-link" onClick={onUndo} title="Revert the most recent snapshot change">
                    <RotateCcw size={10}/> undo last update
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="ln-bal-block right">
            <div className="ln-bal-label">Paid To Date</div>
            <div className="ln-bal-val paid">{rm(paid)}</div>
            <div className="ln-bal-sub">{stats.monthsPaid} of {loan.tenure_months} mo · {paidPct.toFixed(1)}%</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoanStatsGrid({loan, stats}) {
  const isFlat = loan.rate_type === 'flat';
  // For flat rate: also compute the implied effective rate for transparency
  let effectiveLabel = null;
  if (isFlat) {
    // Effective rate (APR equivalent) approximation: 1.85× flat rate is typical for car HP
    const eff = (loan.rate * 1.85).toFixed(2);
    effectiveLabel = \`~\${eff}% effective\`;
  }
  return (
    <div className="ln-stats">
      <div className="ln-stat">
        <div className="ln-stat-top">
          <span className="ln-stat-label">Monthly EMI</span>
          <span className="ln-stat-ic" style={{color:'var(--cyan-bright)',background:'#22d3ee15'}}><CreditCard size={13}/></span>
        </div>
        <div className="ln-stat-val money" style={{color:'var(--cyan-bright)'}}>{rm(stats.emi)}</div>
        <div className="ln-stat-sub">scheduled · <b>{stats.monthsRemaining}</b> months left</div>
      </div>
      <div className="ln-stat">
        <div className="ln-stat-top">
          <span className="ln-stat-label">{isFlat ? 'Profit Rate' : 'Interest Rate'}</span>
          <span className="ln-stat-ic" style={{color:'var(--amber)',background:'#fbbf2415'}}><TrendingUp size={13}/></span>
        </div>
        <div className="ln-stat-val" style={{color:'var(--amber)'}}>{Number(loan.rate).toFixed(2)}% <span style={{fontSize:'11px',color:'var(--text-dim)',fontWeight:400}}>{loan.rate_type === 'flat' ? 'flat' : 'p.a.'}</span></div>
        <div className="ln-stat-sub">{effectiveLabel || (loan.rate_type === 'reducing' ? 'reducing balance' : 'fixed schedule')}</div>
      </div>
      <div className="ln-stat">
        <div className="ln-stat-top">
          <span className="ln-stat-label">Bank</span>
          <span className="ln-stat-ic" style={{color:'var(--teal)',background:'#34d39915'}}><Briefcase size={13}/></span>
        </div>
        <div className="ln-stat-val" style={{color:'var(--teal)',fontSize:'15px'}}>{loan.bank || '—'}</div>
        <div className="ln-stat-sub">{loan.account_no ? <>acc <b>·· {String(loan.account_no).slice(-4)}</b></> : '—'}</div>
      </div>
      <div className="ln-stat">
        <div className="ln-stat-top">
          <span className="ln-stat-label">Tenure</span>
          <span className="ln-stat-ic" style={{color:'var(--purple-light)',background:'#a78bfa15'}}><Clock size={13}/></span>
        </div>
        <div className="ln-stat-val" style={{color:'var(--purple-light)'}}>{loan.tenure_months >= 12 ? \`\${Math.round(loan.tenure_months / 12)} yr\` : \`\${loan.tenure_months} mo\`}</div>
        <div className="ln-stat-sub"><b>{stats.monthsPaid}</b> paid · <b>{stats.monthsRemaining}</b> left</div>
      </div>
    </div>
  );
}

function LoanProgress({loan, stats}) {
  const pct = (stats.monthsPaid / loan.tenure_months) * 100;
  const startLabel = \`\${MONTHS[loan.start_month - 1]} \${loan.start_year}\`;
  const endMonth0 = (loan.start_month - 1 + loan.tenure_months);
  const endYear = loan.start_year + Math.floor(endMonth0 / 12);
  const endMonth = (endMonth0 % 12) + 1;
  const endLabel = \`\${MONTHS[endMonth - 1]} \${endYear}\`;
  return (
    <div className="ln-progress-card">
      <div className="ln-progress-head">
        <span>LOAN PROGRESS · started <b>{startLabel}</b></span>
        <span>ends <b>{endLabel}</b></span>
      </div>
      <div className="ln-bar">
        <div className={loan.kind === 'house' ? 'ln-bar-fill house' : 'ln-bar-fill'} style={{width: pct + '%'}}></div>
      </div>
      <div className="ln-bar-ticks">
        <span>0</span>
        <span>{Math.round(loan.tenure_months * 0.25)}mo</span>
        <span>{Math.round(loan.tenure_months * 0.5)}mo</span>
        <span>{Math.round(loan.tenure_months * 0.75)}mo</span>
        <span>{loan.tenure_months}mo</span>
      </div>
    </div>
  );
}

function LoanCalcBreakdown({loan, stats, onEdit}) {
  const [fxOpen, setFxOpen] = useState(null);
  const isFlat = loan.rate_type === 'flat';
  const yearsLabel = (loan.tenure_months / 12).toFixed(loan.tenure_months % 12 === 0 ? 0 : 1);
  return (
    <div className="ln-card">
      <div className="ln-card-title">
        <CircleDollarSign size={14} color="var(--cyan-bright)"/>
        Loan calculation breakdown
        <span className="ln-tag">{isFlat ? 'flat rate · Hire Purchase' : 'amortizing · reducing balance'}</span>
        {onEdit && (
          <button className="ln-edit-btn-hdr" onClick={onEdit} title="Edit rate, EMI, tenure and other loan parameters">
            <Edit3 size={10}/> Edit details
          </button>
        )}
      </div>
      <div className="ln-calc-row"><span>Purchase Price</span><span style={{color:'var(--text-2)'}}>{rm(loan.purchase_price)}</span></div>
      <div className="ln-calc-row"><span>Down Payment</span><span style={{color:'var(--text-2)'}}>− {rm(loan.down_payment)}</span></div>
      <div className="ln-calc-row"><span>Loan Principal</span><span className="ln-calc-accent">{rm(loan.principal)}</span></div>
      {isFlat ? (
        <>
          <div className="ln-calc-row formula"><span>Monthly EMI<FxInfo amber onClick={() => setFxOpen('emi')} /></span><span>from {loan.bank || 'bank'} statement → <b style={{color:'var(--cyan-bright)'}}>{rm(stats.emi)}</b></span></div>
          <div className="ln-calc-row formula"><span>Total Repayment</span><span>{rm(stats.emi)} × {loan.tenure_months} → <b style={{color:'var(--amber)'}}>{rm(stats.totalRepayment)}</b></span></div>
          <div className="ln-calc-row formula"><span>Total Interest<FxInfo amber onClick={() => setFxOpen('interest')} /></span><span>{rm(stats.totalRepayment)} − {rm(loan.principal)} → <b style={{color:'var(--amber)'}}>{rm(stats.totalInterest)}</b></span></div>
          <div className="ln-calc-row sub"><span>↳ implied flat rate: <b style={{color:'var(--text-2)'}}>{((stats.totalInterest / loan.principal / (loan.tenure_months/12)) * 100).toFixed(2)}%</b> p.a.</span><span></span></div>
          <div className="ln-calc-row sub"><span>↳ effective profit rate (Maybank): <b style={{color:'var(--text-2)'}}>{Number(loan.rate).toFixed(2)}%</b></span><span></span></div>
        </>
      ) : (
        <>
          <div className="ln-calc-row formula"><span>Monthly EMI<FxInfo onClick={() => setFxOpen('emi')} /></span><span>P × [r(1+r)ⁿ ÷ ((1+r)ⁿ−1)] → <b style={{color:'var(--teal)'}}>{rm(stats.emi)}</b></span></div>
          <div className="ln-calc-row sub"><span>↳ where r = {Number(loan.rate).toFixed(2)}% ÷ 12 = {(stats.monthlyRate * 100).toFixed(4)}% monthly</span><span></span></div>
          <div className="ln-calc-row sub"><span>↳ n = {loan.tenure_months} months</span><span></span></div>
          <div className="ln-calc-row formula"><span>Lifetime Interest<FxInfo onClick={() => setFxOpen('interest')} /></span><span>({rm(stats.emi)} × {loan.tenure_months}) − {rm(loan.principal)} → <b style={{color:'var(--amber)'}}>{rm(stats.totalInterest)}</b></span></div>
        </>
      )}
      <div className="ln-calc-row total"><span>Total Repayment over {yearsLabel} yr</span><span style={{color:'var(--amber)'}}>{rm(stats.totalRepayment)}</span></div>
      {fxOpen && <FormulaExplainer kind={fxOpen} loan={loan} stats={stats} onClose={() => setFxOpen(null)} />}
    </div>
  );
}

function LoanPaidBreakdown({loan, stats, onUpdateSnapshot}) {
  const hasSnap = loan.snapshot_paid != null && loan.snapshot_outstanding != null
                  && !(Number(loan.snapshot_paid) === 0 && Number(loan.snapshot_outstanding) === 0);
  const snapPaid = hasSnap ? Number(loan.snapshot_paid) : null;
  const snapOut = hasSnap ? Number(loan.snapshot_outstanding) : null;
  const startLabel = \`\${MONTHS[loan.start_month - 1]} \${loan.start_year}\`;
  const monthIdx = ((loan.start_month - 1) + stats.monthsPaid - 1) % 12;
  const yearOffset = Math.floor(((loan.start_month - 1) + stats.monthsPaid - 1) / 12);
  const lastPaidLabel = stats.monthsPaid > 0 ? \`\${MONTHS[monthIdx]} \${loan.start_year + yearOffset}\` : startLabel;

  return (
    <div className="ln-card">
      <div className="ln-card-title">
        <CheckCircle2 size={14} color="var(--teal)"/>
        What you've paid · {stats.monthsPaid} months in
        <span className="ln-tag">{startLabel} → {lastPaidLabel}</span>
        {onUpdateSnapshot && (
          <button className="ln-snap-btn-hdr" onClick={onUpdateSnapshot} title="Enter latest bank values">
            <Activity size={10}/> {hasSnap ? 'Update' : 'Add'} snapshot
          </button>
        )}
      </div>
      <div className="ln-calc-row"><span>Scheduled Total <em>{stats.monthsPaid} × {rm(stats.emi)}</em></span><span className="ln-calc-pos">{rm(stats.scheduledPaid)}</span></div>
      <div className="ln-calc-row sub"><span>↳ Principal portion</span><span>{rm(stats.scheduledPrincipalPaid)}</span></div>
      <div className="ln-calc-row sub"><span>↳ Interest portion</span><span>{rm(stats.scheduledInterestPaid)}</span></div>
      {hasSnap && (
        <>
          <div className="ln-calc-row" style={{background:'rgba(167,139,250,0.06)',borderRadius:6,padding:'7px 10px',border:'1px solid #a78bfa2a',borderBottom:'none',marginTop:4}}>
            <span><Activity size={11} color="var(--purple-light)"/> Bank-reported Paid <em>{loan.snapshot_date}</em></span>
            <span style={{color:'var(--purple-light)',fontWeight:700}}>{rm(snapPaid)}</span>
          </div>
          <div className="ln-calc-row sub"><span>↳ Difference vs scheduled</span><span style={{color: snapPaid > stats.scheduledPaid ? 'var(--red)' : 'var(--teal)'}}>{snapPaid > stats.scheduledPaid ? '+' : ''}{rm(snapPaid - stats.scheduledPaid)}</span></div>
        </>
      )}
      <div className="ln-calc-row"><span>Outstanding Principal <em>scheduled</em></span><span className="ln-calc-neg">{rm(stats.scheduledOutstandingPrincipal)}</span></div>
      {hasSnap && (
        <div className="ln-calc-row"><span>Bank Settlement Today <em>incl. fees / rebate</em></span><span style={{color:'var(--red)',fontWeight:700}}>{rm(snapOut)}</span></div>
      )}
      <div className="ln-calc-row total"><span>Remaining to Pay <em>{stats.monthsRemaining} months</em></span><span className="ln-calc-neg">{rm(stats.scheduledRemainingTotal)}</span></div>
    </div>
  );
}

function LoanAmortChart({loan, stats}) {
  // Generate principal vs interest per-month, then BUCKET for clean mobile rendering.
  // 420 raw bars + 1px gaps overflows most phone widths and collapses to nothing.
  const N = loan.tenure_months;
  const paid = stats.monthsPaid;

  // Build per-month series
  const monthly = [];
  if (loan.rate_type === 'flat') {
    for (let i = 0; i < N; i++) {
      monthly.push({ p: stats.principalPerMonth, ix: stats.interestPerMonth });
    }
  } else {
    const r = stats.monthlyRate;
    const emi = stats.emi;
    let balance = Number(loan.principal);
    for (let i = 0; i < N; i++) {
      const interestPart = balance * r;
      const principalPart = emi - interestPart;
      monthly.push({ p: principalPart, ix: interestPart });
      balance -= principalPart;
    }
  }

  // Bucket: cap at ~80 bars total. If N <= 80, one bar per month (no aggregation).
  const MAX_BARS = 80;
  const monthsPerBar = N <= MAX_BARS ? 1 : Math.ceil(N / MAX_BARS);
  const numBars = Math.ceil(N / monthsPerBar);

  let maxTotal = 0;
  const buckets = [];
  for (let b = 0; b < numBars; b++) {
    const start = b * monthsPerBar;
    const end = Math.min(start + monthsPerBar, N);
    let sumP = 0, sumI = 0, count = 0;
    for (let i = start; i < end; i++) {
      sumP += monthly[i].p;
      sumI += monthly[i].ix;
      count++;
    }
    const avgP = count > 0 ? sumP / count : 0;
    const avgI = count > 0 ? sumI / count : 0;
    // A bucket is 'paid' if its LAST month is paid
    const paidCol = (end - 1) < paid;
    buckets.push({ p: avgP, ix: avgI, paidCol });
    if (avgP + avgI > maxTotal) maxTotal = avgP + avgI;
  }

  // Scale to pixel heights
  const maxPx = 95;
  const cols = buckets.map(b => ({
    prinH: maxTotal > 0 ? (b.p / maxTotal) * maxPx : 0,
    intH: maxTotal > 0 ? (b.ix / maxTotal) * maxPx : 0,
    paidCol: b.paidCol
  }));

  // Marker still uses raw month proportion for accurate position
  const markerLeft = N > 0 ? (paid / N) * 100 : 0;
  const legendText = loan.rate_type === 'flat'
    ? \`Principal · \${rm(stats.principalPerMonth)}/mo (constant) · Interest · \${rm(stats.interestPerMonth)}/mo (constant)\`
    : 'Interest portion shrinks · principal portion grows over time';

  return (
    <div className="ln-card">
      <div className="ln-card-title">
        <Activity size={14} color="var(--purple)"/>
        Amortization · principal vs interest per payment
        <span className="ln-tag">{N} months{numBars < N ? ' \u00b7 ' + numBars + ' bars' : ''}</span>
      </div>
      <div className="ln-amort-chart">
        {cols.map((c, i) => (
          <div key={i} className={c.paidCol ? 'ln-amort-col paid' : 'ln-amort-col'}>
            <div className="ln-amort-int" style={{height: c.intH + 'px'}}></div>
            <div className="ln-amort-prin" style={{height: c.prinH + 'px'}}></div>
          </div>
        ))}
        <div className="ln-amort-marker" style={{left: markerLeft + '%'}}></div>
      </div>
      <div className="ln-amort-legend">
        <div className="ln-amort-legend-items">
          <span className="ln-leg-prin">Principal</span>
          <span className="ln-leg-int">Interest</span>
          <span className="ln-leg-cur">You're here (mo {paid})</span>
        </div>
        <span style={{fontSize:'9.5px'}}>{legendText}</span>
      </div>
    </div>
  );
}

function CarSkeleton() {
  return (
    <main className="ln-main">
      <div className="ln-hero car">
        <div className="ln-photo"><span className="sk" style={{width:'100%',height:'100%',borderRadius:10}}></span></div>
        <div className="ln-hero-info">
          <span className="sk" style={{width:90,height:10,marginBottom:8}}></span>
          <span className="sk" style={{width:240,height:22,marginBottom:8,display:'block'}}></span>
          <span className="sk" style={{width:180,height:10,marginBottom:14}}></span>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,paddingTop:13,borderTop:'1px dashed var(--border)'}}>
            <div><span className="sk" style={{display:'block',width:80,height:8,marginBottom:6}}></span><span className="sk" style={{display:'block',width:140,height:24}}></span></div>
            <div style={{textAlign:'right'}}><span className="sk" style={{display:'inline-block',width:80,height:8,marginBottom:6}}></span><span className="sk" style={{display:'block',width:140,height:24,marginLeft:'auto'}}></span></div>
          </div>
        </div>
      </div>
      <div className="ln-stats">
        {[1,2,3,4].map(i => (
          <div key={i} className="ln-stat">
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
              <span className="sk" style={{width:60,height:9}}></span>
              <span className="sk" style={{width:24,height:24,borderRadius:8}}></span>
            </div>
            <span className="sk" style={{display:'block',width:90,height:20,marginBottom:5}}></span>
            <span className="sk" style={{display:'block',width:110,height:9}}></span>
          </div>
        ))}
      </div>
      {/* Progress bar placeholder */}
      <div style={{padding:'14px 16px',background:'linear-gradient(135deg,var(--surface-2),var(--bg-2))',border:'1px solid var(--border)',borderRadius:11,marginTop:12}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:10}}>
          <span className="sk" style={{width:160,height:9}}></span>
          <span className="sk" style={{width:90,height:9}}></span>
        </div>
        <span className="sk" style={{display:'block',width:'100%',height:6,borderRadius:3}}></span>
      </div>
      {/* Calc breakdown placeholder */}
      <div style={{padding:'16px 18px',background:'linear-gradient(135deg,var(--surface-2),var(--bg-2))',border:'1px solid var(--border)',borderRadius:11,marginTop:12}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,paddingBottom:9,borderBottom:'1px solid var(--border)'}}>
          <span className="sk" style={{width:14,height:14,borderRadius:4}}></span>
          <span className="sk" style={{width:200,height:12}}></span>
          <span className="sk" style={{width:140,height:16,borderRadius:12,marginLeft:'auto'}}></span>
        </div>
        {[1,2,3,4,5].map(i => (
          <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--border-3)'}}>
            <span className="sk" style={{width:120+(i%3)*20,height:10}}></span>
            <span className="sk" style={{width:80+(i%4)*15,height:10}}></span>
          </div>
        ))}
      </div>
    </main>
  );
}

function HouseSkeleton() { return <CarSkeleton/>; }

function ErrorView({error, onRetry}) {
  return (
    <div className="fp-root">
      <div className="fp-err card">
        <h2>// CONNECTION FAILURE</h2>
        <p style={{color:'var(--text-soft)',fontSize:13}}>The portal couldn't reach the API. Possible causes:</p>
        <ul style={{textAlign:'left',color:'var(--text-soft)',fontSize:12.5,lineHeight:1.8}}>
          <li>D1 schema or seed not yet loaded</li>
          <li>Worker not bound to the D1 database (env.DB)</li>
          <li>Cloudflare Access session expired</li>
        </ul>
        <pre>{error}</pre>
        <button onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

/* ===== DASHBOARD ===== */
function DashboardLoansSkeleton() {
  return (
    <div className="fp-loans-card">
      <div className="fp-loans-h">
        <div className="fp-loans-title-row">
          <span className="sk" style={{width:28,height:28,borderRadius:7}}></span>
          <span className="sk" style={{width:130,height:14}}></span>
          <span className="sk" style={{width:50,height:16,borderRadius:12,marginLeft:6}}></span>
        </div>
      </div>
      <div className="fp-loans-totals">
        <div>
          <span className="sk" style={{display:'block',width:120,height:9,marginBottom:8}}></span>
          <span className="sk" style={{display:'block',width:160,height:20,marginBottom:4}}></span>
          <span className="sk" style={{display:'block',width:200,height:10}}></span>
        </div>
        <div>
          <span className="sk" style={{display:'block',width:140,height:9,marginBottom:8}}></span>
          <span className="sk" style={{display:'block',width:140,height:20,marginBottom:4}}></span>
          <span className="sk" style={{display:'block',width:120,height:10}}></span>
        </div>
      </div>
      <div className="fp-loans-grid">
        {[1,2].map(i => (
          <div key={i} className="fp-loans-mini" style={{cursor:'default'}}>
            <div className="fp-loans-mini-h">
              <span className="sk" style={{width:22,height:22,borderRadius:6}}></span>
              <span className="sk" style={{flex:1,height:11}}></span>
            </div>
            <div className="fp-loans-mini-balrow">
              <span className="sk" style={{width:110,height:13}}></span>
              <span className="sk" style={{width:60,height:10}}></span>
            </div>
            <span className="sk" style={{display:'block',width:'100%',height:4,marginBottom:6,borderRadius:2}}></span>
            <div className="fp-loans-mini-meta">
              <span className="sk" style={{width:80,height:9}}></span>
              <span className="sk" style={{width:70,height:9}}></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardLoansCard({onTabChange, netPosition}) {
  const [loans, setLoans] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/api/loans')
      .then(r => setLoans(r.loans || []))
      .catch(e => setErr(String(e.message || e)));
  }, []);

  if (err) return null; // fail silently on the dashboard
  if (loans === null) return <DashboardLoansSkeleton/>;
  if (loans.length === 0) return null; // hide card if no loans

  const active = loans.filter(l => l.active !== 0);
  if (active.length === 0) return null;

  // Combined totals
  let totalOutstanding = 0;
  let totalMonthly = 0;
  for (const ln of active) {
    const out = (ln.snapshot_outstanding != null && Number(ln.snapshot_outstanding) > 0)
      ? Number(ln.snapshot_outstanding)
      : Number(ln.principal || 0);
    totalOutstanding += out;
    totalMonthly += Number(ln.monthly_payment || 0);
  }

  // Per-loan summary
  const summarize = (ln) => {
    const out = (ln.snapshot_outstanding != null && Number(ln.snapshot_outstanding) > 0)
      ? Number(ln.snapshot_outstanding)
      : Number(ln.principal || 0);
    const principal = Number(ln.principal || 0);
    // months paid via elapsed-time formula (matches stats hook)
    const today = new Date();
    const sy = ln.start_year, sm = (ln.start_month || 1) - 1;
    const elapsed = (today.getFullYear() - sy) * 12 + (today.getMonth() - sm);
    const monthsPaid = Math.max(0, Math.min(ln.tenure_months, elapsed + 1));
    const pctPaid = ln.tenure_months > 0 ? (monthsPaid / ln.tenure_months) * 100 : 0;
    const dueDay = ln.due_day || 1;
    // next due: start + monthsPaid months
    const ny = sy + Math.floor((sm + monthsPaid) / 12);
    const nm = (sm + monthsPaid) % 12;
    const nextLabel = MONTHS[nm].slice(0, 3) + ' ' + dueDay;
    return { ln, out, principal, monthsPaid, pctPaid, nextLabel };
  };

  const car = active.find(l => l.kind === 'car');
  const house = active.find(l => l.kind === 'house');
  const ordered = [car, house].filter(Boolean);
  const summaries = ordered.map(summarize);

  // Loan burden as % of net position
  const burdenPct = (netPosition && netPosition > 0) ? (totalMonthly * 12 / netPosition) * 100 : null;

  const carIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>
    </svg>
  );
  const houseIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </svg>
  );

  return (
    <div className="fp-loans-card reveal">
      <div className="fp-loans-h">
        <div className="fp-loans-title-row">
          <div className="ic">{houseIcon}</div>
          <div className="fp-loans-title">Household Loans</div>
          <span className="fp-loans-pill">{active.length} active</span>
        </div>
      </div>

      <div className="fp-loans-totals">
        <div>
          <div className="fp-loans-total-label">Combined outstanding</div>
          <div className="fp-loans-total-val">{rm(Math.round(totalOutstanding))}</div>
          <div className="fp-loans-total-sub">
            {summaries.map((s, i) => (
              <span key={i}>
                {i > 0 ? ' \u00b7 ' : ''}
                {s.ln.kind === 'car' ? 'Car ' : 'House '}{rm(Math.round(s.out))}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="fp-loans-total-label">Monthly EMI \u00b7 combined</div>
          <div className="fp-loans-total-val emi">{rm(Math.round(totalMonthly))}</div>
          <div className="fp-loans-total-sub">
            {summaries.map((s, i) => (
              <span key={i}>{i > 0 ? ' + ' : ''}{rm(Number(s.ln.monthly_payment))}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="fp-loans-grid">
        {summaries.map(s => (
          <div key={s.ln.id} className="fp-loans-mini" onClick={() => onTabChange && onTabChange(s.ln.kind)}>
            <div className="fp-loans-mini-h">
              <div className={'fp-loans-mini-ic ' + s.ln.kind}>
                {s.ln.kind === 'car' ? carIcon : houseIcon}
              </div>
              <span className="fp-loans-mini-name">{s.ln.name}</span>
              <span className="fp-loans-mini-arrow">{'\u203a'}</span>
            </div>
            <div className="fp-loans-mini-balrow">
              <span className="fp-loans-mini-out">{rm(Math.round(s.out))}</span>
              <span className="fp-loans-mini-pct">{s.pctPaid.toFixed(1)}% paid</span>
            </div>
            <div className="fp-loans-mini-bar">
              <div className="fp-loans-mini-bar-fill" style={{width: s.pctPaid + '%'}}></div>
            </div>
            <div className="fp-loans-mini-meta">
              <span>{s.monthsPaid} / {s.ln.tenure_months} mo</span>
              <span>Next: <b>{s.nextLabel}</b></span>
            </div>
          </div>
        ))}
      </div>

      {burdenPct != null && (
        <div className="fp-loans-foot">
          <span>Annual loan burden: <strong>{rm(Math.round(totalMonthly * 12))}</strong> ({burdenPct.toFixed(1)}% of net position)</span>
          <span>Click any loan to open its tab</span>
        </div>
      )}
    </div>
  );
}

/* ===== PAYMENT TIMELINE (dashboard) ===== */
function PaymentTimeline() {
  const [loans, setLoans] = useState(null);
  const [insts, setInsts] = useState(null);
  const [view, setView] = useState('list');

  useEffect(() => {
    api('/api/loans').then(r => setLoans(r.loans || [])).catch(() => setLoans([]));
    api('/api/installments').then(r => setInsts(r.installments || [])).catch(() => setInsts([]));
  }, []);

  if (loans === null || insts === null) return null;

  const now = new Date();
  const todayDay = now.getDate();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const daysInMonth = new Date(curY, curM, 0).getDate();

  const items = [];
  for (const ln of loans) {
    if (ln.active === 0) continue;
    const day = Math.min(Math.max(1, ln.due_day || 1), daysInMonth);
    // Paid only if Mark Paid / snapshot was done THIS month
    let paidThisMonth = false;
    if (ln.snapshot_date) {
      const sd = new Date(ln.snapshot_date);
      paidThisMonth = (sd.getFullYear() === curY && (sd.getMonth() + 1) === curM);
    }
    items.push({
      day, kind: ln.kind === 'house' ? 'house' : 'car',
      name: ln.name, sub: ln.bank || '',
      amt: Number(ln.monthly_payment || 0),
      paid: paidThisMonth
    });
  }
  for (const it of insts) {
    if (it.status === 'paid') continue;
    // Skip installments not yet active this month (future start) or already finished
    const startY = Number(it.start_year), startM = Number(it.start_month);
    if (startY > curY || (startY === curY && startM > curM)) continue;
    const tenure = Number(it.num_months || 0);
    if (tenure > 0) {
      const endIdx = startY * 12 + (startM - 1) + tenure - 1; // last active month index
      const curIdx = curY * 12 + (curM - 1);
      if (curIdx > endIdx) continue; // already past its final month
    }
    const day = Math.min(Math.max(1, it.due_day || 1), daysInMonth);
    let paidThisMonth = false;
    if (it.last_paid_date) {
      const lpd = new Date(it.last_paid_date);
      paidThisMonth = (lpd.getFullYear() === curY && (lpd.getMonth() + 1) === curM);
    }
    items.push({
      day, kind: 'inst',
      name: it.name, sub: it.category || '',
      amt: Number(it.monthly_payment || 0),
      paid: paidThisMonth
    });
  }
  if (items.length === 0) return null;

  items.sort((a, b) => a.day - b.day || b.amt - a.amt);

  const paidTotal = items.filter(i => i.paid).reduce((s, i) => s + i.amt, 0);
  const dueTotal = items.filter(i => !i.paid).reduce((s, i) => s + i.amt, 0);
  const upcoming = items.filter(i => !i.paid && i.day >= todayDay && i.day <= todayDay + 14);
  const cycleTotal = upcoming.reduce((s, i) => s + i.amt, 0);

  const ord = d => d + (['th','st','nd','rd'][(d%10>3||[11,12,13].includes(d%100))?0:d%10]);
  const KIND = {
    house: { Icon: Home, label: 'House', cls: 'pt-house' },
    car: { Icon: Car, label: 'Car', cls: 'pt-car' },
    inst: { Icon: CreditCard, label: 'Installment', cls: 'pt-inst' }
  };

  const firstDow = (new Date(curY, curM - 1, 1).getDay() + 6) % 7;
  const byDay = {};
  items.forEach(i => { (byDay[i.day] = byDay[i.day] || []).push(i); });
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  let running = 0;

  return (
    <div className="pt-wrap card reveal">
      <div className="pt-top">
        <div className="pt-title-row">
          <span className="pt-zap"><Zap size={13}/></span>
          <span className="pt-title">Payment Timeline</span>
        </div>
        <div className="pt-toggle">
          <button className={view==='list'?'on':''} onClick={()=>setView('list')}><ListIcon size={12}/> List</button>
          <button className={view==='grid'?'on':''} onClick={()=>setView('grid')}><CalendarDays size={12}/> Calendar</button>
        </div>
      </div>

      <div className="pt-cycle">
        <div>
          <div className="pt-cycle-l">THIS CYCLE {'\u00b7'} NEXT 14 DAYS</div>
          <div className="pt-cycle-v"><i>RM</i>{cycleTotal.toLocaleString()}</div>
          <div className="pt-cycle-sub">{upcoming.length} payment{upcoming.length===1?'':'s'} still due</div>
        </div>
        <div className="pt-cycle-tot">
          <div className="pt-tot-row pt-paid"><span>{'\u25cf'} Paid</span><b>{rm(paidTotal)}</b></div>
          <div className="pt-tot-row pt-due"><span>{'\u25cf'} Due</span><b>{rm(dueTotal)}</b></div>
        </div>
      </div>

      {view === 'list' ? (
        <div className="pt-list">
          <div className="pt-spine"/>
          {items.map((i, idx) => {
            running += i.amt;
            const m = KIND[i.kind];
            return (
              <div className="pt-row" key={idx}>
                <div className="pt-daycol">
                  <span className="pt-day">{ord(i.day)}</span>
                  <span className={'pt-dot ' + m.cls + (i.paid ? ' paid' : '')}>{i.paid && <Check size={8} strokeWidth={3}/>}</span>
                </div>
                <div className={'pt-item' + (i.paid ? ' paid' : '')}>
                  <span className={'pt-ic ' + m.cls}><m.Icon size={13}/></span>
                  <div className="pt-item-body">
                    <div className="pt-item-name">{i.name}</div>
                    <div className="pt-item-sub">{m.label}{i.sub ? ' ' + '\u00b7' + ' ' + i.sub : ''}</div>
                  </div>
                  <div className="pt-item-amt">
                    <div className="pt-amt">{rm(i.amt)}</div>
                    <div className="pt-running">{'\u03a3'} {rm(running)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pt-grid-wrap">
          <div className="pt-legend">
            <span><i className="pt-house"/>House</span>
            <span><i className="pt-car"/>Car</span>
            <span><i className="pt-inst"/>Installment</span>
          </div>
          <div className="pt-dow">
            {['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => <span key={d}>{d}</span>)}
          </div>
          <div className="pt-grid">
            {cells.map((d, idx) => {
              if (d === null) return <div key={idx} className="pt-cell empty"/>;
              const dayItems = byDay[d] || [];
              const isToday = d === todayDay;
              const dTot = dayItems.reduce((s, x) => s + x.amt, 0);
              return (
                <div className={'pt-cell' + (isToday ? ' today' : '')} key={idx}>
                  <span className="pt-cell-d">{d}</span>
                  <div className="pt-cell-dots">
                    {dayItems.map((it, j) => <i key={j} className={'pt-cell-dot ' + KIND[it.kind].cls + (it.paid ? ' paid' : '')}/>)}
                  </div>
                  {dTot > 0 && <span className="pt-cell-amt">{dTot.toLocaleString()}</span>}
                </div>
              );
            })}
          </div>
          <div className="pt-grid-note">Faded dots = already paid this month</div>
        </div>
      )}
    </div>
  );
}

function Dashboard({summary, year, onTabChange}) {
  const {monthly, byCategory, personalByPerson, savingsRate, yoyByCategory, yoyPeriodLabel, burdenEvolution, insights, allYears} = summary;

  // Build data array — null for months without data (FIX CLIFF #1)
  const data = MONTHS.map((label, i) => {
    const m = monthly.find(x => x.month === i+1) || {};
    return {
      label,
      month: i+1,
      income: m.total_income,        // null when no data
      expense: m.total_expense,      // null when no data
      net: m.net,                    // null when no data
      hasData: m.has_data
    };
  });

  const active = data.filter(d => d.hasData);
  const totalIncome = active.reduce((s,d)=>s+(d.income||0),0);
  const totalExpense = active.reduce((s,d)=>s+(d.expense||0),0);
  const net = totalIncome - totalExpense;
  const avg = active.length ? totalExpense/active.length : 0;
  const top = byCategory[0];

  const kpis = [
    {label:"Total Income", value: totalIncome, icon: ArrowUpRight, tone:"pos", sub:\`\${year} · \${active.length} mo tracked\`},
    {label:"Total Expense", value: totalExpense, icon: ArrowDownRight, tone:"neg", sub:\`Avg \${rm(Math.round(avg))}/mo\`},
    {label:"Net Position", value: net, icon: net>=0?TrendingUp:TrendingDown, tone: net>=0?"pos":"warn", sub: net>=0?"Surplus":"Deficit"},
    {label:"Top Category", value: top?.total||0, icon: CircleDollarSign, tone:"accent", sub: top?.category||"—"},
  ];

  // Build savings rate chart data (multi-year overlay)
  const yearsForChart = (allYears || []).filter(y => Math.abs(y - year) <= 2 && y <= year);
  const savingsData = MONTHS.map((label, i) => {
    const row = {label, month: i+1};
    for (const y of yearsForChart) {
      const arr = savingsRate?.[y] || [];
      const cell = arr.find(x => x.month === i+1);
      row[\`FY\${String(y).slice(2)}\`] = cell?.rate;
    }
    return row;
  });

  return (
    <main className="fp-main">
      <div className="fp-kpis">
        {kpis.map((k,i)=>(
          <div className="fp-kpi card reveal" style={{animationDelay:\`\${i*70}ms\`}} key={k.label}>
            <div className="fp-kpi-top">
              <span className="fp-kpi-label">{k.label}</span>
              <span className={\`fp-kpi-ic \${k.tone}\`}><k.icon size={16} /></span>
            </div>
            <div className={\`fp-kpi-val \${k.tone}\`}><i className="fp-kpi-rm">RM</i>{rm(Math.round(k.value)).slice(3)}</div>
            <div className="fp-kpi-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <DashboardLoansCard onTabChange={onTabChange} netPosition={net} />

      <PaymentTimeline />

      {/* #2 INSIGHT CARDS */}
      <InsightCards insights={insights} year={year} />

      <div className="fp-charts">
        <div className="card fp-chart-main reveal" style={{animationDelay:"300ms"}}>
          <div className="fp-card-head"><h3>Income vs Expense</h3><span className="fp-tag">monthly · {year}</span></div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data} margin={{left:8, right:14, top:8, bottom:4}}>
              <defs>
                <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--cyan)" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="var(--cyan)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--pink)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--pink)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="label" tick={{fill:"var(--text-dim)", fontSize:11}} axisLine={false} tickLine={false} />
              <YAxis tick={{fill:"var(--text-dim)", fontSize:11}} axisLine={false} tickLine={false} width={56}
                     tickFormatter={v => v>=1000 ? (v/1000)+"k" : v} />
              <Tooltip content={<TT />} />
              {/* connectNulls=false means line stops when data is null — fixes the cliff */}
              <Area type="monotone" dataKey="income" stroke="var(--cyan)" strokeWidth={2} fill="url(#gInc)" connectNulls={false} />
              <Area type="monotone" dataKey="expense" stroke="var(--pink)" strokeWidth={2} fill="url(#gExp)" connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div className="fp-legend">
            <span><i style={{background:"var(--cyan)"}} />Income</span>
            <span><i style={{background:"var(--pink)"}} />Expense</span>
          </div>
        </div>

        {/* #3 SAVINGS RATE OVER TIME (replaces Net Cashflow) */}
        <div className="card fp-chart-side reveal" style={{animationDelay:"380ms"}}>
          <div className="fp-card-head"><h3>Household Surplus Rate</h3><span className="fp-tag">% of income unspent</span></div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={savingsData} margin={{left:8, right:14, top:8, bottom:4}}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="label" tick={{fill:"var(--text-dim)", fontSize:10}} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{fill:"var(--text-dim)", fontSize:11}} axisLine={false} tickLine={false} width={52}
                     tickFormatter={v => v+"%"} />
              <Tooltip content={<TTPct />} />
              {yearsForChart.map((y, i) => {
                const key = \`FY\${String(y).slice(2)}\`;
                const isCurrent = y === year;
                const colors = ['var(--text-faint)', 'var(--purple)', 'var(--cyan)'];
                const color = isCurrent ? 'var(--cyan)' : colors[(yearsForChart.length - 1 - i) % colors.length] || 'var(--text-faint)';
                return (
                  <Line key={key} type="monotone" dataKey={key}
                        stroke={color}
                        strokeWidth={isCurrent ? 2.6 : 1.6}
                        strokeDasharray={isCurrent ? "0" : "4 4"}
                        dot={isCurrent ? {r:2.5, fill: color} : false}
                        connectNulls={false}
                        opacity={isCurrent ? 1 : 0.6} />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
          <div className="fp-legend">
            {yearsForChart.map(y => {
              const isCurrent = y === year;
              const colors = ['var(--text-faint)', 'var(--purple)', 'var(--cyan)'];
              const idx = yearsForChart.length - 1 - yearsForChart.indexOf(y);
              const color = isCurrent ? 'var(--cyan)' : colors[idx % colors.length];
              return <span key={y}><i style={{background:color, opacity: isCurrent ? 1 : 0.6}}/>FY{String(y).slice(2)}</span>;
            })}
          </div>
        </div>
      </div>

      <div className="fp-dashboard-row2">
        <div className="card fp-cat reveal" style={{animationDelay:"460ms"}}>
          <div className="fp-card-head"><h3>Spend by Category</h3><span className="fp-tag">{year}</span></div>
          <div className="fp-cat-list">
            {byCategory.map((c,i) => {
              const pct = totalExpense ? (c.total/totalExpense)*100 : 0;
              const Ico = ICONS[c.icon] || Package;
              return (
                <div className="fp-cat-row" key={c.category}>
                  <div className="fp-cat-ic" style={{color: ACCENT[i%ACCENT.length]}}><Ico size={16} /></div>
                  <div className="fp-cat-name">{c.category}</div>
                  <div className="fp-cat-bar">
                    <div className="fp-cat-fill" style={{width:\`\${pct}%\`, background: ACCENT[i%ACCENT.length]}} />
                  </div>
                  <div className="fp-cat-pct">{pct.toFixed(1)}%</div>
                  <div className="fp-cat-amt">{rm(Math.round(c.total))}</div>
                </div>
              );
            })}
            {byCategory.length===0 && <div style={{color:'var(--text-muted)',fontSize:13,textAlign:'center',padding:20}}>No data yet for {year} — switch to Monthly Entry to start.</div>}
          </div>
        </div>

        {/* #6 YOY % CHANGE BY CATEGORY */}
        <div className="card fp-cat reveal" style={{animationDelay:"540ms"}}>
          <div className="fp-card-head">
            <h3>YoY Change</h3>
            <span className="fp-tag">FY{String(year-1).slice(2)} → FY{String(year).slice(2)}{yoyPeriodLabel && yoyPeriodLabel !== "Full Year" ? \` · \${yoyPeriodLabel}\` : ""}</span>
          </div>
          <div className="fp-yoy-list">
            {(yoyByCategory||[]).slice(0,10).map((c, i) => (
              <div className="fp-yoy-row" key={c.category}>
                <div className="fp-yoy-cat">{c.category}</div>
                <div className="fp-yoy-bar-wrap">
                  <div className={\`fp-yoy-bar \${c.change > 0 ? 'up' : 'down'}\`}
                       style={{width: Math.min(Math.abs(c.change)*1.5, 90)+"%"}} />
                </div>
                <div className={\`fp-yoy-pct \${c.change > 0 ? 'up' : 'down'}\`}>
                  {c.change > 0 ? <ArrowUp size={10}/> : <ArrowDown size={10}/>}
                  {Math.abs(c.change).toFixed(1)}%
                </div>
              </div>
            ))}
            {(!yoyByCategory || yoyByCategory.length === 0) &&
              <div style={{color:'var(--text-muted)',fontSize:13,textAlign:'center',padding:20}}>
                No previous year (FY{String(year-1).slice(2)}) to compare with.
              </div>
            }
          </div>
        </div>
      </div>

      {/* PERSONAL DEDUCTIONS by contributor */}
      {personalByPerson && Object.keys(personalByPerson).length > 0 && (
        <div className="card fp-personal reveal" style={{animationDelay:"600ms"}}>
          <div className="fp-card-head">
            <h3><User size={13}/> Personal Deductions</h3>
            <span className="fp-tag">{year} · per contributor · separate from household</span>
          </div>
          <div className="fp-personal-grid">
            {Object.entries(personalByPerson).map(([cid, p], i) => {
              const accent = i === 0 ? 'var(--cyan)' : 'var(--pink-light)';
              return (
                <div className="fp-personal-card" key={cid} style={{borderColor: accent+'44'}}>
                  <div className="fp-personal-head">
                    <span className="fp-personal-name" style={{color: accent}}>{p.name}</span>
                    <span className="fp-personal-total" style={{color: accent}}>{rm(Math.round(p.total))}</span>
                  </div>
                  <div className="fp-personal-sub">{year} total deductions</div>
                  {p.byCategory.length > 0 && (
                    <div className="fp-personal-breakdown">
                      {p.byCategory.map((c, j) => (
                        <div className="fp-personal-cat" key={j}>
                          <span>{c.category}</span>
                          <b>{rm(Math.round(c.total))}</b>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="fp-burden-hint">
            These deduct from each person's salary individually — they don't appear in "Spend by Category" or affect household totals.
          </div>
        </div>
      )}

      {/* #7 INSTALLMENT BURDEN EVOLUTION */}
      <div className="card fp-burden reveal" style={{animationDelay:"620ms"}}>
        <div className="fp-card-head">
          <h3>Installment Burden Forecast</h3>
          <span className="fp-tag">36 months ahead</span>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={burdenEvolution||[]} margin={{left:8, right:14, top:8, bottom:4}}>
            <defs>
              <linearGradient id="gBurden" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--purple)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--purple)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" tick={{fill:"var(--text-dim)", fontSize:10}} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={36} />
            <YAxis tick={{fill:"var(--text-dim)", fontSize:11}} axisLine={false} tickLine={false} width={56}
                   tickFormatter={v => v>=1000 ? (v/1000)+"k" : v} />
            <Tooltip content={<TT />} />
            <Area type="step" dataKey="burden" stroke="var(--purple)" strokeWidth={2.5} fill="url(#gBurden)" />
          </AreaChart>
        </ResponsiveContainer>
        <div className="fp-burden-hint">
          Step-down pattern: each drop = an installment ending. Lower curve = freed-up cashflow.
        </div>
      </div>
    </main>
  );
}

function InsightCards({insights, year}) {
  if (!insights) return null;
  const cards = [];
  if (insights.biggestJump) {
    const j = insights.biggestJump;
    cards.push({
      icon: Flame, color: 'var(--pink-light)',
      label: 'Biggest YoY Jump',
      value: j.category,
      sub: \`+\${rm(Math.round(j.curr - j.prev))} (+\${j.change.toFixed(1)}%) vs FY\${String(year-1).slice(2)}\`
    });
  }
  cards.push({
    icon: Target, color: 'var(--purple)',
    label: 'Avg Monthly Surplus',
    value: rm(Math.round(insights.avgSurplus || 0)),
    sub: insights.avgSurplus >= 0 ? \`Across tracked months\` : \`Deficit — review spending\`
  });
  const ic = insights.installmentsCleared;
  if (ic) {
    cards.push({
      icon: Award, color: 'var(--cyan)',
      label: 'Installments Cleared',
      value: \`\${ic.cleared} of \${ic.total}\`,
      sub: ic.thisYear > 0 ? \`\${ic.thisYear} cleared this year\` : 'Lifetime'
    });
  }
  if (insights.nextEnding) {
    const n = insights.nextEnding;
    cards.push({
      icon: Calendar, color: 'var(--cyan-bright)',
      label: 'Next Tenure Ends',
      value: n.name,
      sub: \`\${n.months_left} mo left · RM \${n.monthly_payment}/mo freed\`
    });
  }
  return (
    <div className="fp-insights">
      {cards.map((c, i) => (
        <div className="fp-insight-card reveal" key={i} style={{animationDelay:\`\${(i+1)*60 + 200}ms\`}}>
          <div className="fp-insight-icon" style={{color: c.color, background: c.color+"15", borderColor: c.color+"44"}}>
            <c.icon size={14}/>
          </div>
          <div className="fp-insight-body">
            <div className="fp-insight-label">{c.label}</div>
            <div className="fp-insight-value">{c.value}</div>
            <div className="fp-insight-sub">{c.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TTPct({active, payload, label}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="fp-tt">
      <div className="fp-tt-label">{label}</div>
      {payload.filter(p => p.value !== null && p.value !== undefined).map(p => (
        <div key={p.dataKey} className="fp-tt-row">
          <i style={{background: p.color||p.fill}} />
          <span>{p.dataKey}</span><b>{Number(p.value).toFixed(1)}%</b>
        </div>
      ))}
    </div>
  );
}

function TT({active, payload, label}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="fp-tt">
      <div className="fp-tt-label">{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} className="fp-tt-row">
          <i style={{background: p.color||p.fill}} />
          <span>{p.dataKey}</span><b>{rm(Math.round(p.value))}</b>
        </div>
      ))}
    </div>
  );
}

/* ===== LEDGER / ENTRY ===== */
function Ledger({boot, monthData, entryMonth, setEntryMonth, year, saveExpense, saveIncome, addLineItem,
                 deleteLineItem, renameLineItem, editLineItem, duplicateLineItem,
                 moveLineItem, renameCategory, moveCategory, deleteCategory,
                 reorderLineItems, reorderCategories,
                 reloadAfterShareChange}) {
  if (!monthData) return <LedgerSkeleton />;

  const catById = Object.fromEntries(boot.categories.map(c => [c.id, c]));
  const grid = {};
  for (const it of boot.line_items) {
    const cat = catById[it.category_id];
    if (!cat) continue;
    (grid[cat.name] ||= {category: cat, items: []}).items.push({
      ...it,
      amount: monthData.entries.find(e => e.line_item_id === it.id)?.amount ?? ''
    });
  }
  const groups = boot.categories.map(c => grid[c.name]).filter(Boolean);

  const totalIncome = monthData.income.reduce((s,i) => s+(i.salary||0), 0);
  const totalExpense = monthData.monthly_expense || monthData.entries.reduce((s,e) => s+(e.amount||0), 0);

  const [copyOpen, setCopyOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const prevMonthName = MONTHS[(entryMonth === 1 ? 12 : entryMonth - 1) - 1];

  // Shared undo handler: bulk-set items back to their prior amounts
  const undoEntryChange = useCallback(async (snapshot, targetYear, targetMonth, kind) => {
    try {
      await api('/api/entries/bulk-set', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({
          year: targetYear, month: targetMonth,
          items: snapshot.map(s => ({ line_item_id: s.line_item_id, amount: s.prior_amount }))
        })
      });
      await reloadAfterShareChange();
      if (window.__mam_toast) window.__mam_toast(\`Reverted \${kind}\`);
    } catch (e) { alert('Undo failed: ' + e.message); }
  }, [reloadAfterShareChange]);

  return (
    <main className="fp-main">
      <div className="fp-entry-head card reveal">
        <div>
          <span className="fp-pick-label">Period</span>
          <div className="fp-months">
            {MONTHS.map((m,i)=>(
              <button key={m} className={entryMonth===i+1?"on":""} onClick={()=>setEntryMonth(i+1)}>{m}</button>
            ))}
          </div>
          <CopyMonthButton sourceMonthName={prevMonthName} onClick={() => setCopyOpen(true)} />
          <ClearMonthButton onClick={() => setClearOpen(true)}
                            disabled={!monthData || !monthData.entries || !monthData.entries.some(e => e.amount > 0)} />
        </div>
        <div className="fp-entry-totals">
          <div><span>Income</span><b className="pos"><i className="fp-rm-pre">RM</i>{rm(totalIncome).slice(3)}</b></div>
          <div><span>Expense</span><b className="neg"><i className="fp-rm-pre">RM</i>{rm(totalExpense).slice(3)}</b></div>
          <div><span>Net</span><b className={totalIncome-totalExpense>=0?"pos":"warn"}><i className="fp-rm-pre">RM</i>{rm(totalIncome-totalExpense).slice(3)}</b></div>
        </div>
      </div>
      <IncomeBlock monthData={monthData} entryMonth={entryMonth} year={year}
                   saveIncome={saveIncome} reloadAfterShareChange={reloadAfterShareChange}
                   contributors={boot.contributors} />
      <div className="fp-masonry">
        <DraggableCategoryGrid groups={groups} reorderCategories={reorderCategories}
                               saveExpense={saveExpense} deleteLineItem={deleteLineItem}
                               renameLineItem={renameLineItem}
                               editLineItem={editLineItem} duplicateLineItem={duplicateLineItem}
                               renameCategory={renameCategory}
                               deleteCategory={deleteCategory}
                               categories={boot.categories}
                               contributors={boot.contributors}
                               reorderLineItems={reorderLineItems} />
      </div>
      <AddItemFab categories={boot.categories} onAdd={addLineItem} />
      {copyOpen && ReactDOM.createPortal(
        <CopyMonthModal targetYear={year} targetMonth={entryMonth}
                        onClose={() => setCopyOpen(false)}
                        onCopied={async (r) => {
                          const capturedYear = year;
                          const capturedMonth = entryMonth;
                          setCopyOpen(false);
                          await reloadAfterShareChange();
                          if (window.__mam_toast) {
                            const msg = \`Copied \${r.copied} item\${r.copied === 1 ? '' : 's'}\${r.skipped ? \` · \${r.skipped} skipped\` : ''}\`;
                            const opts = r.snapshot && r.snapshot.length > 0
                              ? { duration: 10000, action: { label: 'Undo', onClick: () => undoEntryChange(r.snapshot, capturedYear, capturedMonth, 'copy') } }
                              : {};
                            window.__mam_toast(msg, opts);
                          }
                        }} />,
        document.body
      )}
      {clearOpen && ReactDOM.createPortal(
        <ClearMonthModal year={year} month={entryMonth} monthData={monthData} lineItems={boot.line_items}
                         onClose={() => setClearOpen(false)}
                         onCleared={async (r) => {
                           const capturedYear = year;
                           const capturedMonth = entryMonth;
                           setClearOpen(false);
                           await reloadAfterShareChange();
                           if (window.__mam_toast) {
                             const msg = \`Cleared \${r.cleared} item\${r.cleared === 1 ? '' : 's'}\`;
                             const opts = r.snapshot && r.snapshot.length > 0
                               ? { duration: 10000, action: { label: 'Undo', onClick: () => undoEntryChange(r.snapshot, capturedYear, capturedMonth, 'clear') } }
                               : {};
                             window.__mam_toast(msg, opts);
                           }
                         }} />,
        document.body
      )}
    </main>
  );
}

/* ===== FLOATING ACTION BUTTON for adding line items ===== */
function AddItemFab({categories, onAdd}) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState(categories[0]?.id);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => { setOpen(false); setName(''); setNote(''); setSaving(false); };
  const submit = async () => {
    if (!name.trim() || !cat || saving) return;
    setSaving(true);
    try {
      await onAdd(cat, name.trim(), note.trim());
      close();
    } catch (e) {
      setSaving(false);
      alert('Add failed: ' + e.message);
    }
  };

  return (
    <>
      <button className={\`fp-fab \${open ? 'open' : ''}\`} onClick={() => open ? close() : setOpen(true)}
              title={open ? 'Close' : 'Add line item'}>
        <Plus size={22} />
      </button>
      <button className="fp-entry-bar" onClick={() => setOpen(true)}>
        <Plus size={16} /> New Entry
      </button>
      {open && ReactDOM.createPortal(
        <div className="fp-fab-modal-bg" onClick={close}>
          <div className="fp-fab-modal card" onClick={e => e.stopPropagation()}>
            <div className="fp-fab-head">
              <h3><Plus size={14}/> Add Line Item</h3>
              <button className="ib-x" onClick={close}><X size={14}/></button>
            </div>
            <div className="fp-fab-body">
              <div className="lie-field">
                <label>CATEGORY</label>
                <select value={cat} onChange={e => setCat(Number(e.target.value))}>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="lie-field">
                <label>NAME</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
                       placeholder="e.g. Spotify"
                       onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(); }} />
              </div>
              <div className="lie-field">
                <label>DESCRIPTION <span className="lie-opt">(optional)</span></label>
                <input type="text" value={note} onChange={e => setNote(e.target.value)}
                       placeholder="e.g. RM 14.90/mo"
                       onKeyDown={e => e.key === 'Enter' && submit()} />
                <small><Info size={10}/> Shows as a small grey subtitle under the name.</small>
              </div>
            </div>
            <div className="ib-modal-foot">
              <button className="ib-btn-ghost" onClick={close} disabled={saving}>Cancel</button>
              <button className="ib-btn-solid" onClick={submit} disabled={!name.trim() || saving}>
                <Check size={13}/> {saving ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/* ===== DRAGGABLE CATEGORY GRID (masonry layout) ===== */
function DraggableCategoryGrid({groups, reorderCategories, saveExpense, deleteLineItem, renameLineItem, editLineItem, duplicateLineItem, renameCategory, deleteCategory, categories, contributors, reorderLineItems}) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  const onDragStart = (e, id) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
  };
  const onDragOver = (e, id) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragId && dragId !== id) setOverId(id);
  };
  const onDragLeave = (e) => {
    // Only clear if leaving the card entirely
    if (!e.currentTarget.contains(e.relatedTarget)) setOverId(null);
  };
  const onDrop = (e, targetId) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    const ids = groups.map(g => g.category.id);
    const from = ids.indexOf(dragId);
    const to   = ids.indexOf(targetId);
    if (from < 0 || to < 0) { setDragId(null); setOverId(null); return; }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    reorderCategories(ids).catch(err => alert('Reorder failed: ' + err.message));
    setDragId(null); setOverId(null);
  };
  const onDragEnd = () => { setDragId(null); setOverId(null); };

  return (
    <>
      {groups.map((g) => (
        <div key={g.category.id}
             className={\`fp-cat-drop \${overId === g.category.id ? 'over' : ''} \${dragId === g.category.id ? 'dragging' : ''}\`}
             onDragOver={e => onDragOver(e, g.category.id)}
             onDragLeave={onDragLeave}
             onDrop={e => onDrop(e, g.category.id)}>
          <CategoryCard group={g}
                        onHeaderDragStart={(e) => onDragStart(e, g.category.id)}
                        onHeaderDragEnd={onDragEnd}
                        saveExpense={saveExpense} deleteLineItem={deleteLineItem}
                        renameLineItem={renameLineItem}
                        editLineItem={editLineItem} duplicateLineItem={duplicateLineItem}
                        renameCategory={renameCategory}
                        deleteCategory={deleteCategory}
                        categories={categories}
                        contributors={contributors}
                        reorderLineItems={reorderLineItems} />
        </div>
      ))}
    </>
  );
}

function CategoryCard({group, onHeaderDragStart, onHeaderDragEnd, saveExpense, deleteLineItem, renameLineItem, editLineItem, duplicateLineItem, renameCategory, deleteCategory, categories, contributors, reorderLineItems}) {
  const Ico = ICONS[group.category.icon] || Package;
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(group.category.name);
  useEffect(() => setDraftName(group.category.name), [group.category.name]);

  const commitRename = async () => {
    const v = draftName.trim();
    setEditingName(false);
    if (v && v !== group.category.name) {
      try { await renameCategory(group.category.id, v); }
      catch (e) { alert('Rename failed: ' + e.message); setDraftName(group.category.name); }
    } else { setDraftName(group.category.name); }
  };

  const items = [...group.items].sort((a,b) => ((a.sort_order||0)-(b.sort_order||0)) || (a.id-b.id));
  const subtotal = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);

  // Line item DnD state (scoped to this card)
  const [liDragId, setLiDragId] = useState(null);
  const [liOverId, setLiOverId] = useState(null);

  const onLiDragStart = (e, id) => {
    e.stopPropagation();
    setLiDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', \`li:\${id}\`);
  };
  const onLiDragOver = (e, id) => {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (liDragId && liDragId !== id) setLiOverId(id);
  };
  const onLiDrop = (e, targetId) => {
    e.preventDefault(); e.stopPropagation();
    if (!liDragId || liDragId === targetId) { setLiDragId(null); setLiOverId(null); return; }
    const ids = items.map(x => x.id);
    const from = ids.indexOf(liDragId);
    const to   = ids.indexOf(targetId);
    if (from < 0 || to < 0) { setLiDragId(null); setLiOverId(null); return; }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    reorderLineItems(ids).catch(err => alert('Reorder failed: ' + err.message));
    setLiDragId(null); setLiOverId(null);
  };
  const onLiDragEnd = () => { setLiDragId(null); setLiOverId(null); };

  return (
    <div className="card fp-block reveal">
      <div className="fp-block-head" draggable={!editingName}
           onDragStart={onHeaderDragStart} onDragEnd={onHeaderDragEnd}
           title="Drag the header to reorder categories">
        <span className="fp-drag-grip" aria-hidden>⋮⋮</span>
        <Ico size={15} />
        {editingName ? (
          <input className="fp-cat-edit" autoFocus value={draftName}
                 onChange={e => setDraftName(e.target.value)}
                 onBlur={commitRename}
                 onKeyDown={e => {
                   if (e.key === 'Enter') e.target.blur();
                   else if (e.key === 'Escape') { setDraftName(group.category.name); setEditingName(false); }
                 }} />
        ) : (
          <h4 onDoubleClick={() => setEditingName(true)} title="Double-click to rename, drag header to reorder">{group.category.name}</h4>
        )}
        {subtotal > 0 && (
          <span className="fp-cat-subtotal" title="Total entered for this category this month">
            {rm(subtotal)}
          </span>
        )}
        <button className="fp-cat-ctrl" title="Rename category" onClick={() => setEditingName(true)}>
          <Pencil size={11}/>
        </button>
        <button className="fp-cat-ctrl fp-cat-del" title="Delete category (archives all its line items)"
          onClick={() => {
            const itemCount = group.items.length;
            const msg = itemCount > 0
              ? \`Delete category "\${group.category.name}"?\\n\\nThis will also archive \${itemCount} line item\${itemCount > 1 ? 's' : ''} inside it. Historical data is preserved — past months continue to show this category in the Dashboard.\\n\\nProceed?\`
              : \`Delete category "\${group.category.name}"?\\n\\nIt's empty, so no line items will be affected. The category will be hidden from Monthly Entry.\\n\\nProceed?\`;
            if (confirm(msg)) deleteCategory(group.category);
          }}>
          <X size={11}/>
        </button>
      </div>
      {items.map((it) => (
        <div key={it.id}
             className={\`fp-li-dnd \${liOverId === it.id ? 'over' : ''} \${liDragId === it.id ? 'dragging' : ''}\`}
             onDragOver={e => onLiDragOver(e, it.id)}
             onDrop={e => onLiDrop(e, it.id)}>
          <EditableLineItem item={it} categories={categories} contributors={contributors}
                            onSaveAmount={(v) => saveExpense(it.id, v)}
                            onEditItem={(patch) => editLineItem(it.id, patch)}
                            onDuplicate={() => duplicateLineItem(it)}
                            onDelete={() => deleteLineItem(it.id)}
                            onDragStart={(e) => onLiDragStart(e, it.id)}
                            onDragEnd={onLiDragEnd} />
        </div>
      ))}
    </div>
  );
}

function EditableLineItem({item, categories, contributors, onSaveAmount, onEditItem, onDuplicate, onDelete, onDragStart, onDragEnd}) {
  const [editOpen, setEditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const btnRef = useRef(null);

  // Close menu on outside click + reposition on scroll
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      // Don't close if click was inside the portal-rendered menu
      if (e.target.closest && e.target.closest('.fp-li-menu')) return;
      setMenuOpen(false);
    };
    const reposition = () => {
      if (btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [menuOpen]);

  const openMenu = (e) => {
    e.stopPropagation();
    if (menuOpen) { setMenuOpen(false); return; }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setMenuOpen(true);
  };

  const assignedContributor = item.is_personal && contributors
    ? (contributors.find(c => c.id === item.assigned_contributor_id) || null)
    : null;
  const personalAccent = assignedContributor
    ? (assignedContributor.sort_order === 0 ? 'var(--cyan)' : 'var(--pink-light)')
    : null;

  const label = (
    <span className="fp-li-text" title={item.name + (item.note ? \` — \${item.note}\` : '')}
          onDoubleClick={() => setEditOpen(true)}>
      {item.name}{item.note && <em>{item.note}</em>}
      {item.is_personal === 1 && assignedContributor && (
        <span className="fp-li-personal-pill"
              style={{color: personalAccent, borderColor: personalAccent+'55', background: personalAccent+'15'}}
              title={\`Personal deduction — assigned to \${assignedContributor.name}\`}>
          <User size={8}/> {assignedContributor.name}
        </span>
      )}
    </span>
  );

  return (
    <div className="fp-line-wrap" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <span className="fp-drag-grip-row" aria-hidden>⋮⋮</span>
      <SavingInput label={label} value={item.amount ?? ''} onSave={onSaveAmount} />
      <div className="fp-line-ctrls">
        <button className="fp-line-del" title="Edit (name & description)"
                onClick={() => setEditOpen(true)}>
          <Edit3 size={10}/>
        </button>
        <button ref={btnRef} className="fp-line-del" title="More actions" onClick={openMenu}>
          <MoreVertical size={11}/>
        </button>
      </div>
      {menuOpen && menuPos && ReactDOM.createPortal(
        <div className="fp-li-menu" style={{position: 'fixed', top: menuPos.top, right: menuPos.right}}
             onClick={e => e.stopPropagation()}>
          <button onClick={() => { setMenuOpen(false); onDuplicate(); }}>
            <Copy size={11}/> Duplicate
          </button>
          <button onClick={() => { setMenuOpen(false); setEditOpen(true); }}>
            <Edit3 size={11}/> Edit name &amp; description
          </button>
          <button className="fp-li-menu-danger" onClick={() => {
            setMenuOpen(false);
            if (confirm(\`Delete "\${item.name}"?\\n\\nIt will be removed from the entry grid going forward. Historical data is preserved in the Dashboard.\`)) {
              onDelete();
            }
          }}>
            <X size={11}/> Delete
          </button>
        </div>,
        document.body
      )}
      {editOpen && ReactDOM.createPortal(
        <LineItemEditModal item={item} categories={categories} contributors={contributors}
                           onClose={() => setEditOpen(false)}
                           onSave={async (patch) => { await onEditItem(patch); setEditOpen(false); }} />,
        document.body
      )}
    </div>
  );
}

function LineItemEditModal({item, categories, contributors, onClose, onSave}) {
  const [name, setName] = useState(item.name);
  const [note, setNote] = useState(item.note || '');
  const [categoryId, setCategoryId] = useState(item.category_id);
  const [isPersonal, setIsPersonal] = useState(!!item.is_personal);
  const [assignedContributorId, setAssignedContributorId] = useState(
    item.assigned_contributor_id || (contributors && contributors[0] && contributors[0].id) || null
  );
  const [saving, setSaving] = useState(false);

  const initialPersonal = !!item.is_personal;
  const initialAssigned = item.assigned_contributor_id || null;
  const effectiveAssigned = isPersonal ? assignedContributorId : null;
  const dirty = name.trim() !== item.name
              || note !== (item.note || '')
              || categoryId !== item.category_id
              || isPersonal !== initialPersonal
              || (isPersonal && effectiveAssigned !== initialAssigned);

  const submit = async () => {
    if (!name.trim()) return;
    if (isPersonal && !assignedContributorId) { alert('Pick a contributor for personal items'); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        note,
        category_id: categoryId,
        is_personal: isPersonal ? 1 : 0,
        assigned_contributor_id: isPersonal ? assignedContributorId : null
      });
    } catch (e) { setSaving(false); alert('Save failed: ' + e.message); }
  };

  const assignedName = isPersonal && contributors
    ? (contributors.find(c => c.id === assignedContributorId) || {}).name
    : null;

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 480}}>
        <div className="ib-modal-head">
          <h3><Edit3 size={14}/> Edit Line Item</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="lie-field">
            <label>NAME</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
                   onKeyDown={e => e.key === 'Enter' && note === item.note && submit()} />
          </div>
          <div className="lie-field">
            <label>DESCRIPTION <span className="lie-opt">(optional)</span></label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)}
                   placeholder="e.g. RM 11.20/mo, or any note about this item" />
            <small><Info size={10}/> Shows as a small grey subtitle under the name.</small>
          </div>
          <div className="lie-field">
            <label>CATEGORY</label>
            <select value={categoryId} onChange={e => setCategoryId(Number(e.target.value))}>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <small><Info size={10}/> Move this item to a different category. Historical data follows the item.</small>
          </div>

          {/* NEW: Personal Deduction section */}
          <div className="lie-field">
            <label className="lie-checkbox-label">
              <input type="checkbox" checked={isPersonal} onChange={e => setIsPersonal(e.target.checked)}/>
              <span>PERSONAL DEDUCTION <span className="lie-opt">— deduct from one person's salary instead of splitting</span></span>
            </label>
            {isPersonal && contributors && (
              <div className="lie-contrib-picker">
                <label className="lie-contrib-sub-label">ASSIGN TO</label>
                <div className="lie-contrib-options">
                  {contributors.map(c => {
                    const accent = c.sort_order === 0 ? 'var(--cyan)' : 'var(--pink-light)';
                    return (
                      <button key={c.id} type="button"
                              className={\`lie-contrib-btn \${assignedContributorId === c.id ? 'on' : ''}\`}
                              onClick={() => setAssignedContributorId(c.id)}
                              style={assignedContributorId === c.id ? {
                                borderColor: accent, color: accent, background: accent+'15'
                              } : {}}>
                        <User size={11}/> {c.name}
                      </button>
                    );
                  })}
                </div>
                <div className="lie-preview lie-preview-personal">
                  <Info size={11}/>
                  <span>This item will deduct entirely from <b>{assignedName}'s</b> salary. The other contributor will be unaffected.</span>
                </div>
              </div>
            )}
            {!isPersonal && (
              <div className="lie-preview lie-preview-household">
                <Users size={11}/>
                <span>This is a <b>household item</b>. The amount will be split between contributors by their configured share %.</span>
              </div>
            )}
          </div>
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="ib-btn-solid" onClick={submit} disabled={!dirty || saving || !name.trim()}>
            <Check size={13}/> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SavingInput({label, value, onSave}) {
  const [val, setVal] = useState(value);
  const [state, setState] = useState('idle'); // idle | saving | saved
  const timer = useRef();
  useEffect(() => setVal(value), [value]);
  const commit = async (v) => {
    if (String(v) === String(value)) return;
    setState('saving');
    try {
      await onSave(v);
      setState('saved');
      setTimeout(() => setState('idle'), 900);
    } catch (e) {
      setState('idle');
      alert('Save failed: ' + e.message);
    }
  };
  return (
    <div className="fp-line">
      <div className="fp-line-name">{label}</div>
      <div className={\`fp-input \${state}\`}>
        <span>RM</span>
        <FmtInput value={val} placeholder="0.00"
               onChange={e => setVal(e.target.value)}
               onBlur={() => commit(val)}
               onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
        {state==='saved' && <Check size={12} />}
      </div>
    </div>
  );
}

function AddItemCard({categories, onAdd, delay}) {
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState(categories[0]?.id);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const submit = async () => {
    if (!name.trim() || !cat) return;
    await onAdd(cat, name.trim(), note.trim());
    setName(''); setNote(''); setOpen(false);
  };
  return (
    <div className="card fp-block fp-add reveal" style={{animationDelay:\`\${delay}ms\`}}>
      {!open ? (
        <button className="fp-add-btn" onClick={()=>setOpen(true)}><Plus size={16} /> Add line item</button>
      ) : (
        <div className="fp-add-form">
          <div className="fp-add-label">CATEGORY</div>
          <select value={cat} onChange={e=>setCat(Number(e.target.value))}>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="fp-add-label">NAME</div>
          <input autoFocus value={name} placeholder="e.g. Spotify"
                 onChange={e=>setName(e.target.value)}
                 onKeyDown={e => e.key==='Enter' && !e.shiftKey && submit()} />
          <div className="fp-add-label">DESCRIPTION <span className="lie-opt">(optional)</span></div>
          <input value={note} placeholder="e.g. RM 14.90/mo"
                 onChange={e=>setNote(e.target.value)}
                 onKeyDown={e => e.key==='Enter' && submit()} />
          <div className="fp-add-actions">
            <button className="ghost" onClick={()=>{setOpen(false); setName(''); setNote('');}}>Cancel</button>
            <button className="solid" onClick={submit}><Check size={14} /> Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== INCOME & CONTRIBUTION BLOCK ===== */
function IncomeBlock({monthData, entryMonth, year, saveIncome, reloadAfterShareChange, contributors}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ibPulse, setIbPulse] = useState(false);

  const income = monthData.income || [];
  const monthlyExpense = monthData.monthly_expense || 0;
  const personalByContributor = monthData.personal_by_contributor || {};
  // If ANY contributor has personal items this month, all rows use the wider 8-col layout
  // so columns align between rows. Rows without personal show empty placeholder cells.
  const anyHasPersonal = Object.values(personalByContributor).some(v => Number(v) > 0);

  // Pulse a small ✓ indicator when personalByContributor changes (skip initial mount)
  const lastPersonalKeyRef = useRef(null);
  useEffect(() => {
    const key = JSON.stringify(personalByContributor);
    if (lastPersonalKeyRef.current !== null && lastPersonalKeyRef.current !== key) {
      setIbPulse(true);
      const t = setTimeout(() => setIbPulse(false), 1200);
      lastPersonalKeyRef.current = key;
      return () => clearTimeout(t);
    }
    lastPersonalKeyRef.current = key;
  }, [personalByContributor]);

  return (
    <>
    <div className="card fp-block ib-block reveal" style={{animationDelay:"60ms", gridColumn:"1 / -1"}}>
      <div className="fp-block-head">
        <Wallet size={15} />
        <h4>Income &amp; Contribution</h4>
        <InlineHelp title="Income & Contribution"
                    body="Each person's salary, and how much they contribute to shared expenses based on their share %. Contributions auto-calculate from the household monthly total. Click Edit Split to change percentages." />
        <span className="fp-tag">{MONTHS[entryMonth-1]} {year}</span>
        {ibPulse && <span className="ib-pulse-tag"><Check size={11}/> updated</span>}
        <div className="ib-head-actions">
          <button className="ib-icon-btn" onClick={() => setHistoryOpen(true)} title="Share history">
            <History size={13}/>
          </button>
          <button className="ib-icon-btn ib-edit" onClick={() => setEditorOpen(true)} title="Edit split">
            <Settings2 size={13}/><span>Edit Split</span>
          </button>
        </div>
      </div>

      <div className="ib-section-label">SALARY ENTRY</div>
      {income.map(p => (
        <PersonRow key={p.contributor_id} person={p} monthlyExpense={monthlyExpense}
                   personalDeduction={Number(personalByContributor[p.contributor_id] || 0)}
                   showPersonalLayout={anyHasPersonal}
                   onSave={(v) => saveIncome(p.contributor_id, v)} />
      ))}

      <IncomeSummary income={income} monthlyExpense={monthlyExpense} installmentBurden={monthData.installment_burden || 0} />

      <div className="ib-hint">
        <Info size={11} />
        <span>Contribution = <strong>share %</strong> × <strong>total monthly expense</strong>.
              Surplus = salary − contribution. Click <em>Edit Split</em> to change percentages, effective from a chosen month.</span>
      </div>
    </div>
    {/* Modals rendered into document.body to escape parent card's backdrop-filter stacking context */}
    {editorOpen && ReactDOM.createPortal(
      <ShareEditor income={income} year={year} month={entryMonth}
                   onClose={() => setEditorOpen(false)}
                   onSaved={async () => { setEditorOpen(false); await reloadAfterShareChange(); }} />,
      document.body
    )}
    {historyOpen && ReactDOM.createPortal(
      <ShareHistoryDrawer onClose={() => setHistoryOpen(false)}
                          onChanged={async () => { await reloadAfterShareChange(); }} />,
      document.body
    )}
    </>
  );
}

function PersonRow({person, monthlyExpense, personalDeduction, showPersonalLayout, onSave}) {
  const [val, setVal] = useState(person.salary || '');
  const [state, setState] = useState('idle');
  useEffect(() => setVal(person.salary || ''), [person.salary]);

  const accent = person.contributor_id % 2 === 1 ? "var(--pink)" : "var(--cyan)";
  const salary = parseFloat(val) || 0;
  const contribution = (monthlyExpense || 0) * (person.share || 0);
  const personal = personalDeduction || 0;
  const surplus = salary - contribution;
  const takeHome = surplus - personal;

  // Pulse animations when computed values change (excludes initial mount)
  const [pulseContrib, setPulseContrib] = useState(false);
  const [pulseSurplus, setPulseSurplus] = useState(false);
  const [pulseTakeHome, setPulseTakeHome] = useState(false);
  const prevContribRef = useRef(null);
  const prevSurplusRef = useRef(null);
  const prevTakeHomeRef = useRef(null);
  useEffect(() => {
    if (prevContribRef.current !== null && Math.abs(prevContribRef.current - contribution) > 0.01) {
      setPulseContrib(true);
      const t = setTimeout(() => setPulseContrib(false), 600);
      prevContribRef.current = contribution;
      return () => clearTimeout(t);
    }
    prevContribRef.current = contribution;
  }, [contribution]);
  useEffect(() => {
    if (prevSurplusRef.current !== null && Math.abs(prevSurplusRef.current - surplus) > 0.01) {
      setPulseSurplus(true);
      const t = setTimeout(() => setPulseSurplus(false), 600);
      prevSurplusRef.current = surplus;
      return () => clearTimeout(t);
    }
    prevSurplusRef.current = surplus;
  }, [surplus]);
  useEffect(() => {
    if (prevTakeHomeRef.current !== null && Math.abs(prevTakeHomeRef.current - takeHome) > 0.01) {
      setPulseTakeHome(true);
      const t = setTimeout(() => setPulseTakeHome(false), 600);
      prevTakeHomeRef.current = takeHome;
      return () => clearTimeout(t);
    }
    prevTakeHomeRef.current = takeHome;
  }, [takeHome]);

  const commit = async () => {
    if (String(val) === String(person.salary)) return;
    setState('saving');
    try {
      await onSave(val);
      setState('saved');
      setTimeout(() => setState('idle'), 900);
    } catch (e) { setState('idle'); alert('Save failed: ' + e.message); }
  };

  const hasPersonal = personal > 0;
  // Use wide layout when this row has personal items OR sibling rows do
  const useWideLayout = showPersonalLayout;

  return (
    <div className={\`ib-person-row \${useWideLayout ? 'ib-with-personal' : ''}\`}>
      <div className="ib-person-name">
        <span className="ib-name" style={{borderColor: accent}}>{person.name}</span>
        <span className="ib-share-pill" style={{color: accent, borderColor: accent+"55", background: accent+"15"}}>
          {Math.round((person.share||0)*100)}% share
        </span>
      </div>
      <div className="ib-salary-cell">
        <span className="ib-cell-label">SALARY</span>
        <div className={\`ib-input \${state}\`}>
          <span>RM</span>
          <FmtInput value={val} placeholder="0.00"
                 onChange={e => setVal(e.target.value)} onBlur={commit}
                 onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
          {state === 'saved' && <Check size={12} />}
        </div>
      </div>
      <div className="ib-arrow"><ArrowRight size={13}/></div>
      <div className="ib-contrib-cell">
        <span className="ib-cell-label">CONTRIBUTION <span className="ib-auto">auto</span></span>
        <div className={\`ib-contrib-val \${pulseContrib ? "val-pulse" : ""}\`} style={{color: accent}}>{rm(contribution)}</div>
      </div>
      <div className="ib-surplus-cell">
        <span className="ib-cell-label">
          SURPLUS
          <SurplusInfoTooltip val={salary} contribution={contribution} personal={personal} surplus={surplus} takeHome={takeHome}/>
        </span>
        <div className={\`ib-surplus-val \${surplus >= 0 ? "pos" : "warn"} \${pulseSurplus ? "val-pulse" : ""}\`}>
          {surplus >= 0 ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
          {rm(surplus)}
        </div>
      </div>
      {useWideLayout && (
        <>
          {hasPersonal ? (
            <>
              <div className="ib-arrow ib-arrow-personal"><ArrowRight size={13}/></div>
              <div className="ib-personal-cell">
                <span className="ib-cell-label ib-personal-label"><User size={9}/> PERSONAL</span>
                <div className="ib-personal-val">−{rm(personal)}</div>
              </div>
              <div className="ib-takehome-cell">
                <span className="ib-cell-label ib-takehome-label">TAKE-HOME</span>
                <div className={\`ib-takehome-val \${takeHome >= 0 ? "pos" : "warn"} \${pulseTakeHome ? "val-pulse" : ""}\`}>
                  {takeHome >= 0 ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
                  {rm(takeHome)}
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Empty placeholder cells so the row aligns with sibling rows */}
              <div className="ib-arrow ib-arrow-empty" aria-hidden="true"/>
              <div className="ib-personal-cell ib-cell-empty" aria-hidden="true"/>
              <div className="ib-takehome-cell ib-cell-empty" aria-hidden="true"/>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SurplusInfoTooltip({val, contribution, personal, surplus, takeHome}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [isMobile, setIsMobile] = useState(false);
  const ref = useRef(null);

  const show = (mobile) => {
    if (!mobile && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 9, left: r.left + r.width / 2 });
    }
    setIsMobile(mobile);
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Desktop = hover; Mobile = tap toggle. Click handler decides per-viewport.
  const onClick = (e) => {
    e.stopPropagation();
    const mobile = window.innerWidth < 720;
    if (open) hide(); else show(mobile);
  };
  const onMouseEnter = () => { if (window.innerWidth >= 720) show(false); };
  const onMouseLeave = () => { if (window.innerWidth >= 720) hide(); };
  const onFocus = () => { if (window.innerWidth >= 720) show(false); };

  const hasPersonal = personal > 0;

  const body = (
    <>
      <strong>SURPLUS = SALARY − HOUSEHOLD SHARE</strong>
      <p>Your <b>budget surplus</b> — how much salary remains after your share of household expenses. A clean month-to-month metric for comparing budget health.</p>
      <div className="ib-tt-formula">
        <span>Salary</span><b>{rm(val)}</b>
        <span>− Household Share</span><b>{rm(contribution)}</b>
        <span>= Surplus</span><b className={surplus >= 0 ? "pos" : "warn"}>{rm(surplus)}</b>
      </div>
      {hasPersonal && (
        <>
          <p style={{marginTop:10, color:'var(--purple-light)'}}><b>TAKE-HOME = SURPLUS − PERSONAL DEDUCTIONS</b></p>
          <p>What actually lands in your account after credit card + personal subscriptions.</p>
          <div className="ib-tt-formula">
            <span>Surplus</span><b>{rm(surplus)}</b>
            <span>− Personal Deductions</span><b>{rm(personal)}</b>
            <span>= Take-Home</span><b className={takeHome >= 0 ? "pos" : "warn"}>{rm(takeHome)}</b>
          </div>
        </>
      )}
      <p className="ib-tt-note">⚠️ Take-Home doesn't include untracked spending (coffee, fuel, cash) — only what's logged in the portal.</p>
    </>
  );

  return (
    <span className="ib-info-wrap" ref={ref}
          tabIndex={0}
          onClick={onClick}
          onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
          onFocus={onFocus} onBlur={hide}>
      <Info size={10}/>
      {open && ReactDOM.createPortal(
        isMobile ? (
          // Reuse the EXACT pattern from CopyMonthModal (.ib-modal-bg + .card).
          // This pattern works full-width on iOS Safari PWA. No custom CSS, no
          // visualViewport tracking, no overrides — just the proven shape.
          <div className="ib-modal-bg ib-tt-modal-bg" onClick={hide}>
            <div className="card ib-tt-modal-card" onClick={(e) => e.stopPropagation()}>
              {body}
            </div>
          </div>
        ) : (
          <div className="ib-tooltip" role="tooltip"
               style={{position:'fixed', top: pos && pos.top, left: pos && pos.left, transform:'translateX(-50%)'}}>
            {body}
          </div>
        ),
        document.body
      )}
    </span>
  );
}

function IncomeSummary({income, monthlyExpense, installmentBurden}) {
  const totalIncome = income.reduce((s, p) => s + (p.salary || 0), 0);
  const totalContrib = income.reduce((s, p) => s + monthlyExpense * (p.share || 0), 0);
  const surplus = totalIncome - monthlyExpense;
  const entriesSum = monthlyExpense - (installmentBurden || 0);
  return (
    <div className="ib-summary">
      <div className="ib-summary-row">
        <span className="ib-sum-label">Total Income</span>
        <span className="ib-sum-val pos"><i className="fp-rm-pre">RM</i>{rm(totalIncome).slice(3)}</span>
      </div>
      <div className="ib-summary-row">
        <span className="ib-sum-label">
          Monthly Expense (this month)
          {installmentBurden > 0 && (
            <em className="ib-sum-breakdown">
              = {rm(entriesSum)} entries + {rm(installmentBurden)} installments
            </em>
          )}
        </span>
        <span className="ib-sum-val neg"><i className="fp-rm-pre">RM</i>{rm(monthlyExpense).slice(3)}</span>
      </div>
      <div className="ib-summary-row ib-net">
        <span className="ib-sum-label">Household Surplus</span>
        <span className={\`ib-sum-val \${surplus >= 0 ? "pos" : "warn"}\`}><i className="fp-rm-pre">RM</i>{rm(surplus).slice(3)}</span>
      </div>
    </div>
  );
}

function ShareEditor({income, year, month, onClose, onSaved}) {
  // Person A is income[0], Person B is income[1]
  const a = income[0] || {};
  const b = income[1] || {};
  const initialA = Math.round((a.share||0)*100);
  const [shareA, setShareA] = useState(initialA);
  const [effYear, setEffYear] = useState(year);
  const [effMonth, setEffMonth] = useState(month);
  const [saving, setSaving] = useState(false);
  const shareB = 100 - shareA;
  // Enabled whenever anything is different from the initial state.
  const dirty = shareA !== initialA || effYear !== year || effMonth !== month;

  const handleA = (v) => setShareA(Math.max(0, Math.min(100, v)));

  const submit = async () => {
    setSaving(true);
    try {
      await api('/api/share-history', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({
          effective_year: Number(effYear),
          effective_month: Number(effMonth),
          shares: [
            { contributor_id: a.contributor_id, share: shareA / 100 },
            { contributor_id: b.contributor_id, share: shareB / 100 }
          ]
        })
      });
      onSaved();
    } catch (e) { setSaving(false); alert('Save failed: ' + e.message); }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()}>
        <div className="ib-modal-head">
          <h3><Settings2 size={14}/> Edit Contribution Split</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="ib-modal-note">
            <Info size={11}/>
            <span>Both percentages must add up to 100%. Pick when the new split takes effect — earlier months keep the previous split.</span>
          </div>
          <div className="ib-share-grid">
            <div className="ib-share-card" style={{borderColor:"var(--glow-cyan)"}}>
              <div className="ib-share-card-label">{a.name || 'Person A'}</div>
              <div className="ib-share-card-input">
                <input type="number" min="0" max="100" value={shareA}
                       onChange={e => handleA(parseInt(e.target.value)||0)} />
                <span>%</span>
              </div>
              <input type="range" min="0" max="100" value={shareA}
                     onChange={e => handleA(parseInt(e.target.value))} className="ib-slider person-a"/>
            </div>
            <div className="ib-share-card" style={{borderColor:"var(--glow-pink)"}}>
              <div className="ib-share-card-label">{b.name || 'Person B'}</div>
              <div className="ib-share-card-input">
                <input type="number" value={shareB} readOnly />
                <span>%</span>
              </div>
              <input type="range" min="0" max="100" value={shareB} readOnly className="ib-slider person-b"/>
              <div className="ib-share-auto">auto-balanced</div>
            </div>
          </div>
          <div className="ib-eff">
            <Calendar size={12}/>
            <span>Effective from</span>
            <select value={effMonth} onChange={e => setEffMonth(parseInt(e.target.value))}>
              {MONTHS.map((m,i)=><option key={m} value={i+1}>{m}</option>)}
            </select>
            <select value={effYear} onChange={e => setEffYear(parseInt(e.target.value))}>
              {[2024,2025,2026,2027,2028,2029,2030].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="ib-warn">
            <AlertTriangle size={11}/>
            <span>Months <strong>before {MONTHS[effMonth-1]} {effYear}</strong> keep the previous split.
                  From that month forward, all auto-calculated contributions use the new percentages.</span>
          </div>
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="ib-btn-solid" onClick={submit} disabled={!dirty || saving}>
            <Check size={13}/> {saving ? 'Saving…' : 'Apply New Split'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareHistoryDrawer({onClose, onChanged}) {
  const [events, setEvents] = useState(null);
  const load = useCallback(() => {
    api('/api/share-history').then(r => setEvents(r.events)).catch(()=>setEvents([]));
  }, []);
  useEffect(load, [load]);

  const remove = async (ev) => {
    if (!confirm(\`Delete the share split that started \${MONTHS[ev.effective_month-1]} \${ev.effective_year}?\`)) return;
    try {
      await api(\`/api/share-history/\${ev.effective_year}/\${ev.effective_month}\`, {method:'DELETE'});
      load();
      onChanged();
    } catch (e) { alert(e.message); }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 460}}>
        <div className="ib-modal-head">
          <h3><History size={14}/> Share History</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="ib-modal-note">
            <Info size={11}/>
            <span>Each entry is when a split became active. The current month uses the most recent applicable entry.</span>
          </div>
          {events === null && <div style={{padding:14, color:'var(--text-muted)', fontSize:12}}>Loading…</div>}
          {events && events.length === 0 && <div style={{padding:14, color:'var(--text-muted)', fontSize:12}}>No history yet.</div>}
          {events && events.map((ev, idx) => (
            <div key={idx} className="ib-history-row">
              <div className="ib-hr-when">
                <Calendar size={11}/>
                <span>{MONTHS[ev.effective_month-1]} {ev.effective_year}</span>
                {idx === 0 && <span className="ib-current-pill">current</span>}
              </div>
              <div className="ib-hr-split">
                {ev.shares.map(s => (
                  <span key={s.contributor_id} className="ib-hr-share v">
                    {s.name} {(s.share*100).toFixed(0)}%
                  </span>
                ))}
              </div>
              {events.length > 1 && (
                <button className="ib-hr-rm" onClick={() => remove(ev)} title="Delete entry">
                  <X size={11}/>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ===== START NEW YEAR WIZARD ===== */
function StartNewYearWizard({boot, years, onClose, onComplete}) {
  const maxY = Math.max(...years, new Date().getFullYear());
  const sourceYearDefault = maxY;
  const targetYearDefault = maxY + 1;

  const [step, setStep] = useState(1);          // 1=setup, 2=carryforward, 3=archive, 4=shares, 5=confirm
  const [sourceYear, setSourceYear] = useState(sourceYearDefault);
  const [refMonth, setRefMonth] = useState(12); // default reference: December of source year
  const [targetYear, setTargetYear] = useState(targetYearDefault);
  const [busy, setBusy] = useState(false);

  // Reference month data — loaded from source year/month
  const [refData, setRefData] = useState(null);    // {entries, line_items, categories}
  const [carry, setCarry] = useState({});          // {line_item_id: {checked, amount}}
  const [archives, setArchives] = useState({});    // {line_item_id: boolean}
  const [updateShares, setUpdateShares] = useState(false);
  const [shareA, setShareA] = useState(55);

  // Load reference month when entering step 2
  useEffect(() => {
    if (step !== 2) return;
    setRefData(null);
    Promise.all([
      api(\`/api/entries?year=\${sourceYear}&month=\${refMonth}\`),
      api('/api/bootstrap')
    ]).then(([e, b]) => {
      const byLi = Object.fromEntries(e.entries.map(x => [x.line_item_id, x.amount]));
      const initialCarry = {};
      for (const it of b.line_items) {
        if (!it.active) continue;
        const amt = byLi[it.id] ?? 0;
        initialCarry[it.id] = { checked: amt > 0, amount: amt };
      }
      setCarry(initialCarry);
      setRefData(b);
    }).catch(err => alert("Failed to load reference month: " + err.message));
  }, [step, sourceYear, refMonth]);

  // Group by category for step 2 view
  const grouped = useMemo(() => {
    if (!refData) return [];
    const byCat = {};
    for (const it of refData.line_items) {
      if (!it.active) continue;
      (byCat[it.category_id] ||= []).push(it);
    }
    return refData.categories
      .filter(c => byCat[c.id]?.length)
      .map(c => ({ category: c, items: byCat[c.id].sort((a,b) =>
        ((a.sort_order||0)-(b.sort_order||0)) || (a.id-b.id)) }));
  }, [refData]);

  const toggleAll = (checked) => {
    setCarry(prev => Object.fromEntries(
      Object.entries(prev).map(([id, v]) => [id, {...v, checked}])
    ));
  };
  const toggleCategory = (catId, checked) => {
    if (!refData) return;
    const ids = refData.line_items.filter(it => it.category_id === catId && it.active).map(it => it.id);
    setCarry(prev => {
      const next = {...prev};
      for (const id of ids) if (next[id]) next[id] = {...next[id], checked};
      return next;
    });
  };

  // Stats
  const stats = useMemo(() => {
    const items = Object.entries(carry).filter(([, v]) => v.checked);
    const total = items.reduce((s, [, v]) => s + (parseFloat(v.amount) || 0), 0);
    const archCount = Object.values(archives).filter(Boolean).length;
    return { count: items.length, total, archCount };
  }, [carry, archives]);

  const submit = async () => {
    setBusy(true);
    try {
      const items = Object.entries(carry)
        .filter(([, v]) => v.checked)
        .map(([id, v]) => ({ line_item_id: Number(id), amount: parseFloat(v.amount) || 0 }));
      const archive_ids = Object.entries(archives).filter(([, v]) => v).map(([id]) => Number(id));

      let new_shares = null;
      if (updateShares) {
        const shareB = 100 - shareA;
        // boot.contributors[0] = first inserted; in our case both are stable.
        new_shares = boot.contributors.map((c, i) => ({
          contributor_id: c.id,
          share: (i === 0 ? shareA : shareB) / 100
        }));
      }

      const r = await api('/api/start-new-year', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ target_year: targetYear, items, archive_ids, new_shares })
      });
      onComplete(targetYear);
    } catch (e) {
      setBusy(false);
      alert("Failed: " + e.message);
    }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card sny-modal" onClick={e => e.stopPropagation()}>
        <div className="ib-modal-head">
          <h3><Rocket size={14}/> Start FY{String(targetYear).slice(2)} — Carry Forward</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>

        {/* Step indicator */}
        <div className="sny-steps">
          <span className={step >= 1 ? "on" : ""}>1. Setup</span>
          <ChevronRight size={11}/>
          <span className={step >= 2 ? "on" : ""}>2. Items</span>
          <ChevronRight size={11}/>
          <span className={step >= 3 ? "on" : ""}>3. Archive</span>
          <ChevronRight size={11}/>
          <span className={step >= 4 ? "on" : ""}>4. Shares</span>
          <ChevronRight size={11}/>
          <span className={step >= 5 ? "on" : ""}>5. Confirm</span>
        </div>

        <div className="ib-modal-body">
          {/* ===== STEP 1: SETUP ===== */}
          {step === 1 && (
            <>
              <div className="ib-modal-note">
                <Info size={11}/>
                <span>This wizard creates the next fiscal year for you. It uses your current line items as a template, carries forward typical amounts, and lets you archive items that ended.</span>
              </div>
              <div className="sny-grid">
                <div className="sny-field">
                  <label>Carry forward FROM</label>
                  <div className="sny-row">
                    <select value={sourceYear} onChange={e => setSourceYear(parseInt(e.target.value))}>
                      {years.map(y => <option key={y} value={y}>FY{String(y).slice(2)} ({y})</option>)}
                    </select>
                    <select value={refMonth} onChange={e => setRefMonth(parseInt(e.target.value))}>
                      {MONTHS.map((m,i)=><option key={m} value={i+1}>{m}</option>)}
                    </select>
                  </div>
                  <small>Reference month — its amounts become the FY27 January starting values.</small>
                </div>
                <div className="sny-field">
                  <label>Start new year (TARGET)</label>
                  <select value={targetYear} onChange={e => setTargetYear(parseInt(e.target.value))}>
                    {[maxY+1, maxY+2, maxY+3].map(y => <option key={y} value={y}>FY{String(y).slice(2)} ({y})</option>)}
                  </select>
                  <small>All 12 months will be created.</small>
                </div>
              </div>
              {years.includes(targetYear) && (
                <div className="ib-warn">
                  <AlertTriangle size={11}/>
                  <span><strong>FY{String(targetYear).slice(2)} already exists.</strong> Running this will not delete existing data — it will fill in any missing periods and overwrite January amounts for the items you select.</span>
                </div>
              )}
            </>
          )}

          {/* ===== STEP 2: SELECT ITEMS TO CARRY ===== */}
          {step === 2 && (
            <>
              <div className="ib-modal-note">
                <Info size={11}/>
                <span>Tick items to carry into <em>January {targetYear}</em> with the reference amount. Untick anything that won't continue. You can adjust the starting amount inline.</span>
              </div>
              {!refData && <div style={{padding: 18, color: 'var(--text-dim)', fontSize: 12}}>Loading reference month…</div>}
              {refData && (
                <>
                  <div className="sny-bulk">
                    <button onClick={() => toggleAll(true)}><Check size={11}/> Select all</button>
                    <button onClick={() => toggleAll(false)}><X size={11}/> Deselect all</button>
                    <span className="sny-bulk-info">{stats.count} of {Object.keys(carry).length} selected · {rm(stats.total)} / month</span>
                  </div>
                  {grouped.map(g => {
                    const allOn = g.items.every(it => carry[it.id]?.checked);
                    const Ico = ICONS[g.category.icon] || Package;
                    return (
                      <div key={g.category.id} className="sny-cat-group">
                        <div className="sny-cat-head">
                          <input type="checkbox" checked={allOn}
                                 onChange={e => toggleCategory(g.category.id, e.target.checked)} />
                          <Ico size={13}/>
                          <span>{g.category.name}</span>
                        </div>
                        {g.items.map(it => (
                          <div key={it.id} className="sny-item">
                            <input type="checkbox" checked={carry[it.id]?.checked || false}
                                   onChange={e => setCarry(p => ({...p, [it.id]: {...p[it.id], checked: e.target.checked}}))} />
                            <span className="sny-item-name" title={it.name}>{it.name}</span>
                            <div className="sny-item-amt">
                              <span>RM</span>
                              <FmtInput value={carry[it.id]?.amount ?? 0}
                                     onChange={e => setCarry(p => ({...p, [it.id]: {...p[it.id], amount: e.target.value}}))}
                                     disabled={!carry[it.id]?.checked} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}

          {/* ===== STEP 3: ARCHIVE ENDED ITEMS ===== */}
          {step === 3 && (
            <>
              <div className="ib-modal-note">
                <Info size={11}/>
                <span>Items you didn't carry forward are <em>not auto-archived</em> — they still appear in the entry grid. Tick any that have <strong>permanently ended</strong> to hide them from future Monthly Entry views. Historical data is preserved.</span>
              </div>
              {refData && grouped.map(g => {
                const candidates = g.items.filter(it => !carry[it.id]?.checked);
                if (!candidates.length) return null;
                const Ico = ICONS[g.category.icon] || Package;
                return (
                  <div key={g.category.id} className="sny-cat-group">
                    <div className="sny-cat-head">
                      <Ico size={13}/>
                      <span>{g.category.name}</span>
                    </div>
                    {candidates.map(it => (
                      <div key={it.id} className="sny-item">
                        <input type="checkbox" checked={archives[it.id] || false}
                               onChange={e => setArchives(p => ({...p, [it.id]: e.target.checked}))} />
                        <span className="sny-item-name" title={it.name}>{it.name}</span>
                        <span className="sny-archive-hint">{archives[it.id] ? "→ will be archived" : "stays available"}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {refData && grouped.every(g => g.items.every(it => carry[it.id]?.checked)) && (
                <div style={{padding: 18, color: 'var(--text-dim)', fontSize: 12, fontStyle: 'italic', textAlign: 'center'}}>
                  All items are being carried forward — nothing to archive.
                </div>
              )}
            </>
          )}

          {/* ===== STEP 4: SHARE SPLIT ===== */}
          {step === 4 && (
            <>
              <div className="ib-modal-note">
                <Info size={11}/>
                <span>Optionally start FY{String(targetYear).slice(2)} with a new contribution split (effective from January). Leave unchecked to keep the existing split.</span>
              </div>
              <label className="sny-toggle">
                <input type="checkbox" checked={updateShares} onChange={e => setUpdateShares(e.target.checked)} />
                <span>Set new share split for FY{String(targetYear).slice(2)}</span>
              </label>
              {updateShares && boot.contributors.length === 2 && (
                <div className="ib-share-grid">
                  <div className="ib-share-card" style={{borderColor:"var(--glow-cyan)"}}>
                    <div className="ib-share-card-label">{boot.contributors[0].name}</div>
                    <div className="ib-share-card-input">
                      <input type="number" min="0" max="100" value={shareA}
                             onChange={e => setShareA(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))} />
                      <span>%</span>
                    </div>
                    <input type="range" min="0" max="100" value={shareA}
                           onChange={e => setShareA(parseInt(e.target.value))} className="ib-slider person-a"/>
                  </div>
                  <div className="ib-share-card" style={{borderColor:"var(--glow-pink)"}}>
                    <div className="ib-share-card-label">{boot.contributors[1].name}</div>
                    <div className="ib-share-card-input">
                      <input type="number" value={100 - shareA} readOnly />
                      <span>%</span>
                    </div>
                    <input type="range" min="0" max="100" value={100 - shareA} readOnly className="ib-slider person-b"/>
                    <div className="ib-share-auto">auto-balanced</div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ===== STEP 5: CONFIRM ===== */}
          {step === 5 && (
            <>
              <div className="ib-modal-note">
                <Info size={11}/>
                <span>Review the actions below. Clicking <em>Create</em> will execute them in a single batch.</span>
              </div>
              <div className="sny-summary">
                <div className="sny-summary-row">
                  <span>📅 Create periods</span>
                  <b>All 12 months of {targetYear}</b>
                </div>
                <div className="sny-summary-row">
                  <span>📋 Carry forward to January {targetYear}</span>
                  <b>{stats.count} items · {rm(stats.total)}</b>
                </div>
                <div className="sny-summary-row">
                  <span>🗄️ Archive ended items</span>
                  <b>{stats.archCount} items</b>
                </div>
                <div className="sny-summary-row">
                  <span>👥 New share split</span>
                  <b>{updateShares ? \`\${shareA}% / \${100-shareA}% from Jan \${targetYear}\` : "no change"}</b>
                </div>
              </div>
              <div className="ib-warn">
                <AlertTriangle size={11}/>
                <span>This will modify your database. Historical years remain untouched. Archived items can still be restored later via SQL.</span>
              </div>
            </>
          )}
        </div>

        <div className="ib-modal-foot">
          {step > 1 && <button className="ib-btn-ghost" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
          <div style={{flex: 1}}></div>
          <button className="ib-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {step < 5 ? (
            <button className="ib-btn-solid" onClick={() => setStep(step + 1)}
                    disabled={step === 2 && !refData}>
              Next <ChevronRight size={13}/>
            </button>
          ) : (
            <button className="ib-btn-solid" onClick={submit} disabled={busy}>
              <Rocket size={13}/> {busy ? "Creating…" : \`Create FY\${String(targetYear).slice(2)}\`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===== PWA INSTALL PROMPT =====
   Trigger: 3rd+ visit AND (no prior dismissal OR dismissed > 7 days ago).
   Trap-safe: char classes instead of \\d/\\s, double-quoted strings (no apostrophes),
   no template literals (no \\$ or backtick escaping needed). */
function InstallPrompt() {
  const [installEvt, setInstallEvt] = useState(null);
  const [visible, setVisible] = useState(false);

  // Bump visit counter once per session (on mount)
  useEffect(() => {
    try {
      var n = parseInt(localStorage.getItem("mam-pwa-visits") || "0", 10);
      if (!isFinite(n) || n < 0) n = 0;
      localStorage.setItem("mam-pwa-visits", String(n + 1));
    } catch (_) {}
  }, []);

  // Listen for the browser cue; only show banner if criteria met
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      try {
        var visits = parseInt(localStorage.getItem("mam-pwa-visits") || "0", 10);
        var dismissedAt = parseInt(localStorage.getItem("mam-pwa-dismissed") || "0", 10);
        var sevenDays = 7 * 24 * 60 * 60 * 1000;
        var recentlyDismissed = dismissedAt && (Date.now() - dismissedAt < sevenDays);
        if (visits >= 3 && !recentlyDismissed) {
          setInstallEvt(e);
          setVisible(true);
        }
      } catch (_) {}
    };
    window.addEventListener("beforeinstallprompt", handler);
    // If already installed, hide forever
    window.addEventListener("appinstalled", () => {
      setVisible(false);
      try { localStorage.setItem("mam-pwa-dismissed", String(Date.now() + 365*24*60*60*1000)); } catch(_) {}
    });
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const install = async () => {
    if (!installEvt) return;
    try {
      installEvt.prompt();
      await installEvt.userChoice;
    } catch (_) {}
    setInstallEvt(null);
    setVisible(false);
  };

  const dismiss = () => {
    try { localStorage.setItem("mam-pwa-dismissed", String(Date.now())); } catch (_) {}
    setVisible(false);
  };

  if (!visible || !installEvt) return null;

  return ReactDOM.createPortal(
    <div className="pwa-prompt" role="dialog" aria-label="Install app">
      <div className="pwa-prompt-icon">
        <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
          <circle cx="60" cy="60" r="42" fill="none" stroke="var(--cyan)" strokeWidth="2" opacity="0.6"/>
          <polyline points="24,60 38,60 43,42 48,72 53,49 58,60 64,56 70,64 76,60 96,60" fill="none" stroke="var(--teal)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="60" cy="60" r="4" fill="var(--cyan)"/>
          <circle cx="74" cy="40" r="3.2" fill="var(--pink)" opacity="0.9"/>
        </svg>
      </div>
      <div className="pwa-prompt-body">
        <div className="pwa-prompt-title">Install moneyallmatters</div>
        <div className="pwa-prompt-sub">Quick access from your home screen \u00b7 works offline</div>
      </div>
      <div className="pwa-prompt-actions">
        <button className="pwa-prompt-x" onClick={dismiss}>Not now</button>
        <button className="pwa-prompt-yes" onClick={install}>Install</button>
      </div>
    </div>,
    document.body
  );
}

/* Register the service worker once on page load. Silent on failure. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

/* ===== INSTALLMENTS TRACKER ===== */
// ============================================================
// SAVINGS MODULE
// ============================================================
const GOAL_ICONS = { Heart, Plane, Car, Home, GraduationCap, Gift, Briefcase, Target, Sparkles };
const GOAL_ICON_NAMES = ['Heart', 'Plane', 'Car', 'Home', 'GraduationCap', 'Gift', 'Briefcase', 'Target', 'Sparkles'];
const GOAL_COLORS = ['#22d3ee', '#a78bfa', '#fb7185', '#fbbf24', '#34d399', '#f9a8d4', '#67e8f9'];

function Savings({boot, monthData, entryMonth}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = async () => {
    try { setData(await api('/api/savings/bootstrap')); }
    catch (e) { setErr(String(e.message || e)); }
  };

  useEffect(() => { refresh(); }, []);

  if (err) return <main className="fp-main"><div className="card sv-empty">Couldn't load savings: {err}</div></main>;
  if (!data) return <SavingsSkeleton />;

  const primary = data.accounts.find(a => a.id === 1) || data.accounts[0];
  if (!primary) {
    return (
      <main className="fp-main">
        <div className="card sv-empty">
          <Wallet size={40}/>
          <h3>No Savings Account Yet</h3>
          <p>Run the savings migration to create your Grab Bank account, then refresh.</p>
        </div>
      </main>
    );
  }

  // Latest snapshot + previous month snapshot
  const acctSnaps = (data.snapshots || []).filter(s => s.account_id === primary.id);
  const sortedSnaps = [...acctSnaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const latest = sortedSnaps[sortedSnaps.length - 1];

  // Get current entry month's Person A surplus + saved
  // Surplus = clean (salary - household). Take-Home = Surplus - personal deductions.
  const personAIncome = monthData?.income?.[0];
  const personASalary = personAIncome?.salary || 0;
  const monthlyExpense = monthData?.monthly_expense || 0;
  const personAContribution = monthlyExpense * (personAIncome?.share || 0);
  const personASurplus = personASalary - personAContribution;
  const personAPersonal = Number((monthData?.personal_by_contributor || {})[personAIncome?.contributor_id] || 0);
  const personATakeHome = personASurplus - personAPersonal;

  // Saved this entry-month (sum of contributed for snapshots in that month)
  const entryYM = \`\${monthData?.year || new Date().getFullYear()}-\${String(entryMonth).padStart(2, '0')}\`;
  const savedThisMonth = sortedSnaps
    .filter(s => s.snapshot_date.startsWith(entryYM) && s.contributed != null)
    .reduce((sum, s) => sum + Number(s.contributed), 0);

  return (
    <main className="fp-main sv-main">
      <SavingsAccountCard account={primary} latest={latest} prev={sortedSnaps[sortedSnaps.length - 2]} onRefresh={refresh} />
      <SavingsThisMonth surplus={personASurplus} personal={personAPersonal} takeHome={personATakeHome}
                         saved={savedThisMonth} target={primary.monthly_target} account={primary} onRefresh={refresh} entryYM={entryYM} />
      <SavingsGoals goals={data.goals || []} totalBalance={data.total_balance || 0} accountId={primary.id} onRefresh={refresh} />
      <SavingsSnapshots snapshots={sortedSnaps} account={primary} onRefresh={refresh} />
      <SavingsInsightCards insights={data.insights} primary={primary} latest={latest}
                            personATakeHome={personATakeHome} savedThisMonth={savedThisMonth} entryYM={entryYM} />
    </main>
  );
}

// ===== ACCOUNT CARD =====
function SavingsAccountCard({account, latest, prev, onRefresh}) {
  const [formType, setFormType] = useState(null);  // 'deposit' | 'withdraw' | 'adjustment' | null
  const [editOpen, setEditOpen] = useState(false);
  const balance = latest?.balance || 0;
  const delta = (latest?.balance || 0) - (prev?.balance || 0);
  const updatedLabel = latest ? latest.snapshot_date : 'never';

  return (
    <div className="card sv-acc-card reveal" style={{animationDelay:'60ms'}}>
      <div className="sv-acc-left">
        <div className="sv-acc-bank">
          {(() => {
            const logoUrl = getBankLogo(account.name);
            return logoUrl
              ? <div className="sv-acc-bank-logo has-img"><img src={logoUrl} alt={account.name + ' logo'}/></div>
              : <div className="sv-acc-bank-logo">{account.name[0]}</div>;
          })()}
          <div>
            <div className="sv-acc-bank-name">{account.name}</div>
            <div className="sv-acc-bank-meta">{account.type || 'Account'} · since {account.opened_at?.slice(0, 7) || '—'}</div>
          </div>
        </div>
        <div className="sv-acc-balance-block">
          <div className="sv-acc-balance-label">CURRENT BALANCE</div>
          <div className="sv-acc-balance">{rm(Math.round(balance))}</div>
          {prev && (
            <div className="sv-acc-delta">
              <span className={\`sv-acc-delta-pill \${delta >= 0 ? 'up' : 'down'}\`}>
                {delta >= 0 ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
                {delta >= 0 ? '+' : ''}{rm(Math.round(delta))}
              </span>
              <span className="sv-acc-delta-sub">vs {prev.snapshot_date} · updated {updatedLabel}</span>
            </div>
          )}
        </div>
      </div>
      <div className="sv-acc-right">
        <div className="sv-acc-actions">
          <button className="sv-btn-deposit" onClick={() => setFormType('deposit')} title="Record a deposit">
            <ArrowDownRight size={13}/> Deposit
          </button>
          <button className="sv-btn-withdraw" onClick={() => setFormType('withdraw')} title="Record a withdrawal">
            <ArrowUpRight size={13}/> Withdraw
          </button>
        </div>
        <div className="sv-acc-actions-row">
          <button className="sv-btn-edit-sm" onClick={() => setFormType('adjustment')} title="Adjust balance (interest, correction)">
            <Edit3 size={10}/> Adjust
          </button>
          <button className="sv-btn-edit-sm" onClick={() => setEditOpen(true)} title="Edit account details">
            <Edit3 size={10}/> Edit Account
          </button>
        </div>
      </div>
      {formType && ReactDOM.createPortal(
        <SnapshotForm account={account} latest={latest} defaultType={formType}
                      onClose={() => setFormType(null)}
                      onSaved={() => { setFormType(null); onRefresh(); }} />,
        document.body
      )}
      {editOpen && ReactDOM.createPortal(
        <AccountEditForm account={account} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onRefresh(); }} />,
        document.body
      )}
    </div>
  );
}

// ===== SNAPSHOT FORM (add or edit) =====
function SnapshotForm({account, latest, existing, defaultType, onClose, onSaved}) {
  const today = new Date().toISOString().slice(0, 10);
  // Infer transaction type from existing data
  const inferType = () => {
    if (defaultType) return defaultType;
    if (!existing) return 'deposit';
    if (existing.contributed == null) return 'adjustment';
    if (Number(existing.contributed) < 0) return 'withdraw';
    if (Number(existing.contributed) > 0) return 'deposit';
    return 'adjustment';
  };
  const [txType, setTxType] = useState(inferType());
  const [date, setDate] = useState(existing?.snapshot_date || today);
  // Amount field is always POSITIVE; we apply the sign based on txType
  const [amount, setAmount] = useState(existing ? Math.abs(Number(existing.contributed) || 0) || '' : '');
  // For 'adjustment' you set balance directly. For deposit/withdraw, balance is computed from prev + amount.
  const [adjustBalance, setAdjustBalance] = useState(existing?.balance ?? '');
  const [note, setNote] = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);

  const prevBalance = Number(latest?.balance || 0);
  const amountNum = parseFloat(amount) || 0;

  // Compute new balance based on type
  let newBalance = null;
  let contributedSigned = null;
  if (txType === 'deposit') {
    newBalance = prevBalance + amountNum;
    contributedSigned = amountNum;
  } else if (txType === 'withdraw') {
    newBalance = prevBalance - amountNum;
    contributedSigned = -amountNum;
  } else {
    // adjustment — user types the balance directly, contribution is null (unknown)
    newBalance = parseFloat(adjustBalance);
    contributedSigned = null;
  }

  const submit = async () => {
    let bal, contrib;
    if (txType === 'adjustment') {
      bal = parseFloat(adjustBalance);
      if (isNaN(bal)) { alert('Balance is required'); return; }
      contrib = null;
    } else {
      if (!amount || amountNum <= 0) { alert('Amount must be greater than zero'); return; }
      bal = newBalance;
      contrib = contributedSigned;
    }
    if (txType === 'withdraw' && bal < 0) {
      if (!confirm(\`This withdrawal would put your balance at RM \${bal.toFixed(2)} (negative). Continue?\`)) return;
    }
    setSaving(true);
    try {
      const body = {
        account_id: account.id,
        snapshot_date: date,
        balance: bal,
        contributed: contrib,
        note: note || null
      };
      if (existing) {
        await api(\`/api/savings/snapshots/\${existing.id}\`, {
          method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
        });
      } else {
        await api('/api/savings/snapshots', {
          method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
        });
      }
      onSaved();
    } catch (e) { setSaving(false); alert('Save failed: ' + e.message); }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 480}}>
        <div className="ib-modal-head">
          <h3>
            {txType === 'deposit'    && <><ArrowDownRight size={14}/> {existing ? 'Edit Deposit' : 'Record Deposit'}</>}
            {txType === 'withdraw'   && <><ArrowUpRight size={14}/> {existing ? 'Edit Withdrawal' : 'Record Withdrawal'}</>}
            {txType === 'adjustment' && <><Edit3 size={14}/> {existing ? 'Edit Adjustment' : 'Adjust Balance'}</>}
          </h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          {/* Transaction Type tabs */}
          <div className="sv-tx-tabs">
            <button className={\`sv-tx-tab sv-tx-deposit \${txType === 'deposit' ? 'on' : ''}\`} onClick={() => setTxType('deposit')} type="button">
              <ArrowDownRight size={12}/> Deposit
            </button>
            <button className={\`sv-tx-tab sv-tx-withdraw \${txType === 'withdraw' ? 'on' : ''}\`} onClick={() => setTxType('withdraw')} type="button">
              <ArrowUpRight size={12}/> Withdraw
            </button>
            <button className={\`sv-tx-tab sv-tx-adjust \${txType === 'adjustment' ? 'on' : ''}\`} onClick={() => setTxType('adjustment')} type="button">
              <Edit3 size={12}/> Adjust
            </button>
          </div>

          <div className="lie-field">
            <label>DATE</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          {txType !== 'adjustment' ? (
            <>
              <div className="lie-field">
                <label>AMOUNT (RM) <span className="lie-opt">— how much you {txType === 'deposit' ? 'added' : 'withdrew'}</span></label>
                <FmtInput value={amount} onChange={e => setAmount(e.target.value)}
                       autoFocus placeholder="e.g. 500" />
              </div>
              {/* Show computed before/after balance */}
              {amount && amountNum > 0 && (
                <div className="sv-tx-preview">
                  <div className="sv-tx-prev-row">
                    <span>Previous balance</span>
                    <b>{rm(prevBalance)}</b>
                  </div>
                  <div className="sv-tx-prev-row sv-tx-prev-delta">
                    <span>{txType === 'deposit' ? 'You add' : 'You withdraw'}</span>
                    <b className={txType === 'deposit' ? 'pos' : 'neg'}>
                      {txType === 'deposit' ? '+' : '−'} {rm(amountNum)}
                    </b>
                  </div>
                  <div className="sv-tx-prev-row sv-tx-prev-after">
                    <span>New balance</span>
                    <b className={newBalance >= 0 ? 'cyan' : 'neg'}>{rm(newBalance)}</b>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="lie-field">
                <label>NEW BALANCE (RM) <span className="lie-opt">— direct correction, no contribution tracked</span></label>
                <FmtInput value={adjustBalance} onChange={e => setAdjustBalance(e.target.value)}
                       autoFocus placeholder={\`Current: \${prevBalance.toFixed(2)}\`} />
                <small><Info size={10}/> Use this for interest payments, statement corrections, or initial balance entry. The change won't count toward your monthly target.</small>
              </div>
            </>
          )}

          <div className="lie-field">
            <label>NOTE <span className="lie-opt">(optional)</span></label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)}
                   placeholder={
                     txType === 'deposit' ? 'e.g. Monthly savings, Bonus added' :
                     txType === 'withdraw' ? 'e.g. Emergency: car repair, Family expense' :
                     'e.g. Interest paid, Statement reconciliation'
                   } />
          </div>
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className={\`ib-btn-solid sv-tx-submit-\${txType}\`}
                  onClick={submit}
                  disabled={saving || (txType !== 'adjustment' ? !amount || amountNum <= 0 : adjustBalance === '')}>
            <Check size={13}/>
            {saving ? 'Saving…' :
              (existing ? 'Save' :
                (txType === 'deposit' ? 'Record Deposit' :
                 txType === 'withdraw' ? 'Record Withdrawal' :
                 'Save Adjustment'))}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== ACCOUNT EDIT FORM =====
function AccountEditForm({account, onClose, onSaved}) {
  const [name, setName] = useState(account.name);
  const [type, setType] = useState(account.type || '');
  const [target, setTarget] = useState(account.monthly_target || 0);
  const [opened, setOpened] = useState(account.opened_at || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api(\`/api/savings/accounts/\${account.id}\`, {
        method: 'PATCH', headers: {'content-type':'application/json'},
        body: JSON.stringify({ name, type, monthly_target: Number(target), opened_at: opened || null })
      });
      onSaved();
    } catch (e) { setSaving(false); alert('Save failed: ' + e.message); }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 460}}>
        <div className="ib-modal-head">
          <h3><Edit3 size={14}/> Edit Account</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="lie-field"><label>NAME</label><input type="text" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
          <div className="lie-field"><label>TYPE</label><input type="text" value={type} onChange={e=>setType(e.target.value)} placeholder="e.g. Digital Bank, FD, Investment"/></div>
          <div className="lie-field">
            <label>MONTHLY TARGET (RM)</label>
            <FmtInput value={target} onChange={e=>setTarget(e.target.value)} placeholder="1500"/>
            <small><Info size={10}/> Your goal to save each month. Used for "target hit rate" insight.</small>
          </div>
          <div className="lie-field"><label>OPENED ON</label><input type="date" value={opened} onChange={e=>setOpened(e.target.value)}/></div>
        </div>
        <div className="ib-modal-foot">
          <button className="ib-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="ib-btn-solid" onClick={submit} disabled={saving}>
            <Check size={13}/> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== THIS MONTH FLOW =====
function SavingsThisMonth({surplus, personal, takeHome, saved, target, account, onRefresh, entryYM}) {
  const hasPersonal = personal > 0;
  const discretionary = takeHome - saved;  // Discretionary now uses take-home (not surplus)
  const hit = target > 0 && saved >= target;
  return (
    <div className="card sv-tmf reveal" style={{animationDelay:'140ms'}}>
      <div className="fp-card-head">
        <h3>This Month — Cash Flow</h3>
        <span className="fp-tag">{entryYM}</span>
      </div>
      <div className="sv-tmf-body">
        <div className="sv-tmf-row">
          <div className="sv-tmf-step">
            <div className="sv-tmf-step-label">YOUR SURPLUS</div>
            <div className="sv-tmf-step-value">{rm(Math.round(surplus))}</div>
            <div className="sv-tmf-step-sub">Salary − household share</div>
          </div>
          {hasPersonal && (
            <>
              <div className="sv-tmf-arrow">−</div>
              <div className="sv-tmf-step sv-tmf-step-personal">
                <div className="sv-tmf-step-label">PERSONAL DEDUCTIONS</div>
                <div className="sv-tmf-step-value">{rm(Math.round(personal))}</div>
                <div className="sv-tmf-step-sub">Credit card, personal subs</div>
              </div>
              <div className="sv-tmf-arrow">=</div>
              <div className="sv-tmf-step sv-tmf-step-takehome">
                <div className="sv-tmf-step-label">TAKE-HOME</div>
                <div className="sv-tmf-step-value">{rm(Math.round(takeHome))}</div>
                <div className="sv-tmf-step-sub">Actual cash in hand</div>
              </div>
            </>
          )}
        </div>
        <div className="sv-tmf-row" style={{marginTop:11}}>
          <div className="sv-tmf-step sv-tmf-step-saved">
            <div className="sv-tmf-step-label">SAVED THIS MONTH</div>
            <div className="sv-tmf-step-value">{rm(Math.round(saved))}</div>
            <div className="sv-tmf-step-sub">{takeHome > 0 ? \`\${((saved / takeHome) * 100).toFixed(0)}% of take-home\` : 'No take-home this month'}</div>
          </div>
          <div className="sv-tmf-arrow">+</div>
          <div className="sv-tmf-step sv-tmf-step-disc">
            <div className="sv-tmf-step-label">DISCRETIONARY</div>
            <div className="sv-tmf-step-value">{rm(Math.round(discretionary))}</div>
            <div className="sv-tmf-step-sub">Untracked spending (coffee, fuel, cash)</div>
          </div>
        </div>
        {target > 0 && (
          <div className="sv-tmf-target">
            <Target size={11}/>
            <span>Monthly target: <b>{rm(Math.round(target))}</b></span>
            <span className={\`sv-tmf-target-pill \${hit ? 'on' : 'off'}\`}>
              {hit ? '✓ Hit target this month' : \`\${rm(Math.round(target - saved))} below target\`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== GOALS =====
function SavingsGoals({goals, totalBalance, accountId, onRefresh}) {
  const [addOpen, setAddOpen] = useState(false);
  const [editGoal, setEditGoal] = useState(null);

  const activeCount = goals.filter(g => !g.is_scheduled).length;
  const scheduledCount = goals.filter(g => g.is_scheduled).length;

  return (
    <div className="card sv-goals reveal" style={{animationDelay:'220ms'}}>
      <div className="fp-card-head">
        <h3>Goals</h3>
        <span className="fp-tag">
          {activeCount} active{scheduledCount > 0 ? \` · \${scheduledCount} scheduled\` : ''} · allocated by priority
        </span>
      </div>
      <div className="sv-goals-list">
        {goals.length === 0 && (
          <div className="sv-goal-empty">
            <Target size={20}/>
            <span>No goals yet. Add one to start tracking specific savings targets.</span>
          </div>
        )}
        {goals.map(g => <GoalRow key={g.id} goal={g} onEdit={() => setEditGoal(g)} />)}
        <button className="sv-goal-add" onClick={() => setAddOpen(true)}>
          <Plus size={13}/> Add a goal
        </button>
      </div>
      {addOpen && ReactDOM.createPortal(
        <GoalForm accountId={accountId} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); onRefresh(); }} />,
        document.body
      )}
      {editGoal && ReactDOM.createPortal(
        <GoalForm accountId={accountId} existing={editGoal} onClose={() => setEditGoal(null)} onSaved={() => { setEditGoal(null); onRefresh(); }} />,
        document.body
      )}
    </div>
  );
}

function GoalRow({goal, onEdit}) {
  const Icon = GOAL_ICONS[goal.icon] || Target;
  const color = goal.color || 'var(--cyan)';
  const isScheduled = !!goal.is_scheduled;
  const today = new Date();

  const pct = goal.target_amount > 0 ? Math.min(100, ((goal.allocated || 0) / goal.target_amount) * 100) : 0;
  const needed = goal.target_amount - (goal.allocated || 0);

  const dateLabel = goal.target_date
    ? new Date(goal.target_date).toLocaleDateString('en-MY', {month:'short', year:'numeric'})
    : '—';
  const startLabel = goal.start_date
    ? new Date(goal.start_date).toLocaleDateString('en-MY', {month:'short', year:'numeric'})
    : null;

  // Pace math
  let monthsAvailable, monthsUntilStart;
  if (isScheduled) {
    // Saving window = start_date → target_date
    monthsAvailable = goal.target_date ? monthsBetweenStr(new Date(goal.start_date), goal.target_date) : null;
    monthsUntilStart = monthsBetweenStr(today, goal.start_date);
  } else {
    monthsAvailable = goal.target_date ? monthsBetweenStr(today, goal.target_date) : null;
  }
  const monthlyNeeded = (monthsAvailable && monthsAvailable > 0) ? needed / monthsAvailable : 0;

  return (
    <div className={\`sv-goal-row \${isScheduled ? 'sv-goal-scheduled' : ''}\`}>
      <div className="sv-goal-head">
        <div className="sv-goal-icon" style={{
          color, background: color + (isScheduled ? '08' : '15'),
          borderColor: color + (isScheduled ? '22' : '55'),
          opacity: isScheduled ? 0.55 : 1
        }}>
          <Icon size={15}/>
        </div>
        <div className="sv-goal-info">
          <div className="sv-goal-name-row">
            <span className="sv-goal-name">{goal.name}</span>
            {isScheduled
              ? <span className="sv-goal-status-tag sv-goal-status-scheduled">
                  <Clock size={9}/> SCHEDULED · starts {startLabel}
                </span>
              : <span className="sv-goal-status-tag sv-goal-status-active">ACTIVE</span>}
          </div>
          <div className="sv-goal-meta">
            {goal.target_date && (
              <>
                <Calendar size={9}/>
                {isScheduled
                  ? <span>by {dateLabel} · saving window: {monthsAvailable} months ({startLabel} → {dateLabel})</span>
                  : <span>by {dateLabel} · {monthsAvailable} months left</span>}
              </>
            )}
            {!goal.target_date && <span>No target date</span>}
          </div>
        </div>
        <div className="sv-goal-amounts">
          <div className="sv-goal-current">{rm(Math.round(goal.allocated || 0))}</div>
          <div className="sv-goal-target">of {rm(Math.round(goal.target_amount))}</div>
        </div>
        <button className="sv-goal-edit" onClick={onEdit} title="Edit goal"><Edit3 size={10}/></button>
      </div>
      <div className="sv-goal-progress">
        <div className="sv-goal-bar">
          <div className="sv-goal-fill" style={{
            width: \`\${pct}%\`,
            background: isScheduled
              ? \`repeating-linear-gradient(45deg, \${color}33, \${color}33 6px, \${color}22 6px, \${color}22 12px)\`
              : \`linear-gradient(90deg, \${color}, \${color}aa)\`,
            boxShadow: isScheduled ? 'none' : \`0 0 10px \${color}66\`
          }}/>
        </div>
        <div className="sv-goal-pct">{pct.toFixed(0)}%</div>
      </div>
      {!isScheduled && pct < 100 && monthsAvailable > 0 && (
        <div className="sv-goal-pace">
          <AlertCircle size={9}/>
          <span>Save <b>{rm(Math.round(monthlyNeeded))}/mo</b> to hit by {dateLabel}</span>
        </div>
      )}
      {!isScheduled && pct >= 100 && (
        <div className="sv-goal-pace sv-goal-done">
          <Check size={9}/>
          <span><b>Goal reached!</b> 🎉</span>
        </div>
      )}
      {isScheduled && monthsAvailable > 0 && (
        <div className="sv-goal-pace sv-goal-pace-scheduled">
          <Clock size={9}/>
          <span>Starts in <b>{monthsUntilStart} months</b> · then save <b>{rm(Math.round(monthlyNeeded))}/mo</b> for {monthsAvailable} months</span>
        </div>
      )}
    </div>
  );
}

function GoalForm({accountId, existing, onClose, onSaved}) {
  const [name, setName] = useState(existing?.name || '');
  const [target, setTarget] = useState(existing?.target_amount || '');
  const [date, setDate] = useState(existing?.target_date || '');
  const [startDate, setStartDate] = useState(existing?.start_date || '');
  const [showStartField, setShowStartField] = useState(!!existing?.start_date);
  const [icon, setIcon] = useState(existing?.icon || 'Target');
  const [color, setColor] = useState(existing?.color || 'var(--cyan)');
  const [saving, setSaving] = useState(false);

  const todayStr = new Date().toISOString().slice(0, 10);
  const startErr = showStartField && startDate && date && startDate >= date;
  const willBeScheduled = showStartField && startDate && startDate > todayStr;

  const submit = async () => {
    if (!name.trim() || !target) { alert('Name and target are required'); return; }
    if (startErr) { alert('Start date must be before target date'); return; }
    setSaving(true);
    try {
      const body = {
        account_id: accountId,
        name: name.trim(),
        target_amount: parseFloat(target),
        target_date: date || null,
        start_date: showStartField && startDate ? startDate : null,
        icon, color
      };
      if (existing) {
        await api(\`/api/savings/goals/\${existing.id}\`, {
          method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
        });
      } else {
        await api('/api/savings/goals', {
          method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)
        });
      }
      onSaved();
    } catch (e) { setSaving(false); alert('Save failed: ' + e.message); }
  };

  const del = async () => {
    if (!confirm(\`Delete goal "\${existing.name}"?\\n\\nIt will be removed from the list. Other goals will re-allocate balance.\`)) return;
    setSaving(true);
    try {
      await api(\`/api/savings/goals/\${existing.id}\`, { method: 'DELETE' });
      onSaved();
    } catch (e) { setSaving(false); alert('Delete failed: ' + e.message); }
  };

  return (
    <div className="ib-modal-bg" onClick={onClose}>
      <div className="ib-modal card" onClick={e => e.stopPropagation()} style={{maxWidth: 480}}>
        <div className="ib-modal-head">
          <h3><Target size={14}/> {existing ? 'Edit Goal' : 'Add a Goal'}</h3>
          <button className="ib-x" onClick={onClose}><X size={14}/></button>
        </div>
        <div className="ib-modal-body">
          <div className="lie-field"><label>NAME</label><input type="text" value={name} onChange={e=>setName(e.target.value)} autoFocus placeholder="e.g. Japan Vacation"/></div>
          <div className="lie-field"><label>TARGET AMOUNT (RM)</label><FmtInput value={target} onChange={e=>setTarget(e.target.value)} placeholder="12000"/></div>
          <div className="lie-field"><label>TARGET DATE <span className="lie-opt">(optional)</span></label><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></div>
          <div className="lie-field">
            <label className="sv-defer-toggle">
              <input type="checkbox" checked={showStartField} onChange={e => setShowStartField(e.target.checked)}/>
              <span>SAVE FOR LATER <span className="lie-opt">— set a future start date</span></span>
            </label>
            {showStartField && (
              <>
                <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{marginTop:8}} min={todayStr}/>
                {startErr && (
                  <small className="sv-err"><AlertCircle size={10}/> Start date must be before target date</small>
                )}
                {willBeScheduled && !startErr && (
                  <div className="sv-preview">
                    <Clock size={11}/>
                    <span>This goal will be <b>SCHEDULED</b>. It won't consume balance until <b>{new Date(startDate).toLocaleDateString('en-MY', {month:'short', day:'numeric', year:'numeric'})}</b>.</span>
                  </div>
                )}
                {!willBeScheduled && startDate && !startErr && (
                  <div className="sv-preview sv-preview-ok">
                    <Check size={11}/>
                    <span>Start date is today or earlier — goal is active immediately.</span>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="lie-field">
            <label>ICON</label>
            <div className="sv-icon-picker">
              {GOAL_ICON_NAMES.map(ic => {
                const IconComp = GOAL_ICONS[ic];
                return (
                  <button key={ic} className={icon === ic ? 'on' : ''} onClick={() => setIcon(ic)} type="button" title={ic}
                          style={icon === ic ? {borderColor: color, color, background: color+'15'} : {}}>
                    <IconComp size={14}/>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="lie-field">
            <label>COLOR</label>
            <div className="sv-color-picker">
              {GOAL_COLORS.map(c => (
                <button key={c} className={color === c ? 'on' : ''} onClick={() => setColor(c)} type="button"
                        style={{background: c, boxShadow: color === c ? \`0 0 0 2px var(--bg-2), 0 0 0 4px \${c}\` : 'none'}}/>
              ))}
            </div>
          </div>
        </div>
        <div className="ib-modal-foot">
          {existing && <button className="ib-btn-ghost sv-btn-del" onClick={del} disabled={saving}>Delete</button>}
          <div style={{flex:1}}/>
          <button className="ib-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="ib-btn-solid" onClick={submit} disabled={saving}>
            <Check size={13}/> {saving ? 'Saving…' : (existing ? 'Save' : 'Add Goal')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== SNAPSHOT HISTORY =====
function SavingsSnapshots({snapshots, account, onRefresh}) {
  const [editSnap, setEditSnap] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const sorted = [...snapshots].sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
  const display = showAll ? sorted : sorted.slice(0, 6);

  const del = async (s) => {
    if (!confirm(\`Delete snapshot from \${s.snapshot_date}?\`)) return;
    try {
      await api(\`/api/savings/snapshots/\${s.id}\`, { method: 'DELETE' });
      onRefresh();
    } catch (e) { alert('Delete failed: ' + e.message); }
  };

  return (
    <div className="card sv-snaps reveal" style={{animationDelay:'300ms'}}>
      <div className="fp-card-head">
        <h3>Snapshot History</h3>
        <span className="fp-tag">{sorted.length} total</span>
      </div>
      <div className="sv-snap-list">
        {display.length === 0 && (
          <div className="sv-snap-empty">No snapshots yet. Click "Update Balance" to log your first.</div>
        )}
        {display.map(s => {
          const latest = sorted[0];
          const txType = s.contributed == null ? 'adjustment'
                       : Number(s.contributed) < 0 ? 'withdraw'
                       : Number(s.contributed) > 0 ? 'deposit'
                       : 'adjustment';
          const txLabel = txType === 'deposit' ? 'DEPOSIT'
                        : txType === 'withdraw' ? 'WITHDRAWAL'
                        : 'ADJUSTMENT';
          return (
          <div className={\`sv-snap-row sv-snap-\${txType}\`} key={s.id}>
            <div className="sv-snap-ym">
              <div className="sv-snap-mo">{s.snapshot_date}</div>
              <div className="sv-snap-tags">
                {s.id === latest?.id && <span className="sv-snap-latest">latest</span>}
                <span className={\`sv-snap-tx-tag sv-snap-tx-\${txType}\`}>{txLabel}</span>
              </div>
            </div>
            <div className="sv-snap-balance">
              <div className="sv-snap-balance-label">BALANCE</div>
              <div className="sv-snap-balance-val">{rm(Math.round(s.balance))}</div>
            </div>
            <div className="sv-snap-contrib">
              <div className="sv-snap-balance-label">CHANGE</div>
              <div className={\`sv-snap-contrib-val \${s.contributed >= 0 ? 'up' : 'down'}\`}>
                {s.contributed != null ? (s.contributed >= 0 ? '+' : '') + rm(Math.round(s.contributed)) : <em>—</em>}
              </div>
            </div>
            <div className="sv-snap-note">
              {s.note || <em className="sv-snap-note-empty">— no note —</em>}
            </div>
            <div className="sv-snap-actions">
              <button className="sv-snap-edit" onClick={() => setEditSnap(s)} title="Edit"><Edit3 size={10}/></button>
              <button className="sv-snap-edit sv-snap-del" onClick={() => del(s)} title="Delete"><X size={10}/></button>
            </div>
          </div>
        );})}
      </div>
      {sorted.length > 6 && (
        <div className="sv-snap-more">
          <button onClick={() => setShowAll(s => !s)}>
            {showAll ? 'Show fewer' : \`Show all \${sorted.length}\`}
          </button>
        </div>
      )}
      {editSnap && ReactDOM.createPortal(
        <SnapshotForm account={account} existing={editSnap}
                      latest={sorted.find(s => s.id !== editSnap.id)}
                      onClose={() => setEditSnap(null)}
                      onSaved={() => { setEditSnap(null); onRefresh(); }} />,
        document.body
      )}
    </div>
  );
}

// ===== INSIGHTS =====
function SavingsInsightCards({insights, primary, latest, personATakeHome, savedThisMonth, entryYM}) {
  if (!insights) return null;
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const cards = [];

  // Take-Home Capture Rate — what % of your actual cash-in-hand you saved
  if (personATakeHome > 0) {
    const captureRate = (savedThisMonth / personATakeHome) * 100;
    let verdict;
    if (captureRate >= 80) verdict = 'Excellent discipline';
    else if (captureRate >= 50) verdict = 'Solid — captured most of it';
    else if (captureRate >= 25) verdict = 'Some take-home leaking to spending';
    else if (captureRate > 0) verdict = 'Most take-home spent — review habits';
    else verdict = 'No savings yet this month';
    cards.push({
      icon: Activity, color: captureRate >= 50 ? 'var(--teal)' : captureRate >= 25 ? 'var(--amber-2)' : 'var(--pink-light)',
      label: 'Take-Home Capture Rate',
      value: \`\${Math.max(0, captureRate).toFixed(0)}%\`,
      sub: \`\${rm(Math.round(savedThisMonth))} saved of \${rm(Math.round(personATakeHome))} take-home · \${verdict}\`
    });
  }

  if (insights.bestMonth) {
    const [y, m] = insights.bestMonth.ym.split('-');
    cards.push({ icon: Trophy, color: 'var(--teal)', label: 'Best Saving Month',
                 value: \`\${MONTH_NAMES[Number(m)-1]} \${y}\`,
                 sub: \`+\${rm(Math.round(insights.bestMonth.amount))} saved\` });
  }
  if (insights.targetHitRate) {
    const r = insights.targetHitRate;
    cards.push({ icon: Target, color: 'var(--purple)', label: 'Target Hit Rate',
                 value: \`\${r.hit} of \${r.total} mo\`,
                 sub: \`\${r.pct.toFixed(0)}% — \${r.pct >= 70 ? 'solid consistency' : 'room to improve'}\` });
  }
  if (insights.avgMonthlySave != null) {
    cards.push({ icon: Flame, color: 'var(--cyan)', label: 'Avg Monthly Save',
                 value: rm(Math.round(insights.avgMonthlySave)),
                 sub: 'Rolling average from snapshots' });
  }
  if (insights.goalEta) {
    const g = insights.goalEta;
    cards.push({ icon: Calendar, color: 'var(--pink-light)', label: \`\${g.name} ETA\`,
                 value: \`\${MONTH_NAMES[g.eta_month-1]} \${g.eta_year}\`,
                 sub: \`At current pace · \${g.months_at_pace} mo left\` });
  }

  if (cards.length === 0) return null;

  return (
    <div className="sv-insights reveal" style={{animationDelay:'380ms'}}>
      {cards.map((c, i) => (
        <div className="fp-insight-card" key={i}>
          <div className="fp-insight-icon" style={{color: c.color, background: c.color+'15', borderColor: c.color+'44'}}>
            <c.icon size={14}/>
          </div>
          <div className="fp-insight-body">
            <div className="fp-insight-label">{c.label}</div>
            <div className="fp-insight-value">{c.value}</div>
            <div className="fp-insight-sub">{c.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function monthsBetweenStr(d1, dateStr) {
  const d2 = new Date(dateStr);
  return Math.max(0, (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()));
}

function Installments({boot}) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState("active");
  const [buyer, setBuyer] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);

  const reload = useCallback(() => {
    api('/api/installments').then(r => setItems(r.installments)).catch(()=>setItems([]));
  }, []);
  useEffect(reload, [reload]);

  const today = { y: new Date().getFullYear(), m: new Date().getMonth() + 1 };
  const computeStats = (it) => {
    const elapsed = Math.max(0, (today.y - it.start_year) * 12 + (today.m - it.start_month) + 1);
    const cap = Math.min(elapsed, it.num_months);

    // Real paid amount takes precedence if user has logged any payments via "Mark Paid"
    const hasRealData = (it.paid_amount || 0) > 0 || it.status === 'paid';
    let paid_months, paid;
    if (it.status === 'paid') {
      paid_months = it.num_months;
      paid = it.total_amount;
    } else if (hasRealData) {
      paid = Math.min(Number(it.paid_amount) || 0, Number(it.total_amount));
      paid_months = it.monthly_payment ? Math.round(paid / it.monthly_payment) : 0;
    } else {
      // Fallback: calendar-based estimate (legacy behavior)
      paid_months = cap;
      paid = Math.min(paid_months * it.monthly_payment, it.total_amount);
    }

    const remaining = Math.max(0, it.total_amount - paid);
    const remaining_months = Math.max(0, it.num_months - paid_months);
    const pct = it.total_amount ? (paid / it.total_amount) * 100 : 0;
    const endMonth0 = (it.start_month - 1 + it.num_months);
    const end = { y: it.start_year + Math.floor(endMonth0 / 12), m: (endMonth0 % 12) + 1 };

    // "Behind" detection: by calendar we should be at month \`cap\`, but we've only paid \`paid_months\`
    const months_behind = it.status === 'paid' ? 0 : Math.max(0, cap - paid_months);
    return { paid_months, paid, remaining, remaining_months, pct, end, scheduled_months: cap, months_behind };
  };

  const filtered = useMemo(() => {
    if (!items) return [];
    return items.filter(it =>
      (filter === "all" || it.status === filter) &&
      (buyer === "all" || it.buyer_name === buyer) &&
      (!query || (it.name + " " + (it.category||"")).toLowerCase().includes(query.toLowerCase()))
    );
  }, [items, filter, buyer, query]);

  const kpis = useMemo(() => {
    if (!items) return {active_count:0, paid_count:0, overdue_count:0, total_remaining:0, monthly_burden:0, total_committed:0};
    const active = items.filter(i => i.status === "active");
    const overdue = items.filter(i => i.status === "overdue");
    const paid = items.filter(i => i.status === "paid");
    const total_remaining = [...active, ...overdue].reduce((s, i) => s + computeStats(i).remaining, 0);

    // Monthly Burden — the cost THIS calendar month.
    //   Counts if tenure window covers this month AND
    //   (not paid, OR paid_at >= this month).
    //   So an installment paid off THIS month still counts (this month
    //   IS its final outflow), but next month it stops.
    const now = new Date();
    const nowIdx = now.getFullYear() * 12 + now.getMonth();
    const monthly_burden = items.reduce((s, i) => {
      const startIdx = Number(i.start_year) * 12 + (Number(i.start_month) - 1);
      const endIdx   = startIdx + Number(i.num_months);
      if (nowIdx < startIdx || nowIdx >= endIdx) return s;  // outside tenure
      if (i.status === 'paid' && i.paid_at_year && i.paid_at_month) {
        const paidIdx = Number(i.paid_at_year) * 12 + (Number(i.paid_at_month) - 1);
        if (paidIdx < nowIdx) return s;   // paid_at strictly BEFORE this month → skip
      }
      return s + Number(i.monthly_payment);
    }, 0);

    const total_committed = items.reduce((s, i) => s + i.total_amount, 0);
    return { active_count: active.length, paid_count: paid.length, overdue_count: overdue.length,
             total_remaining, monthly_burden, total_committed };
  }, [items]);

  const counts = {
    all: items?.length || 0,
    active: items?.filter(i => i.status === "active").length || 0,
    overdue: items?.filter(i => i.status === "overdue").length || 0,
    paid: items?.filter(i => i.status === "paid").length || 0,
  };

  const handleSave = async (data) => {
    const id = editItem?.id;
    if (id) {
      await api(\`/api/installments/\${id}\`, {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(data)});
    } else {
      await api('/api/installments', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data)});
    }
    setModalOpen(false); setEditItem(null); reload();
  };
  const handleDelete = async (id) => {
    if (!confirm('Delete this installment? This cannot be undone.')) return;
    await api(\`/api/installments/\${id}\`, {method:'DELETE'});
    reload();
  };
  const handleEdit = (it) => { setEditItem(it); setModalOpen(true); };

  const handlePay = async (it) => {
    try {
      const r = await api(\`/api/installments/\${it.id}/pay\`, {method:'POST'});
      setItems(curr => curr.map(x => x.id === it.id ? {...x, paid_amount: r.paid_amount, status: r.status} : x));
    } catch (e) { alert('Failed: ' + e.message); }
  };
  const handleUnpay = async (it) => {
    if (!confirm(\`Undo last payment for "\${it.name}"?\\n\\nThis subtracts \${rm(it.monthly_payment)} from paid amount.\`)) return;
    try {
      const r = await api(\`/api/installments/\${it.id}/pay\`, {method:'DELETE'});
      setItems(curr => curr.map(x => x.id === it.id ? {...x, paid_amount: r.paid_amount, status: r.status} : x));
    } catch (e) { alert('Failed: ' + e.message); }
  };

  if (!items) return <InstallmentsSkeleton />;
  const buyers = [...new Set(items.map(i => i.buyer_name).filter(Boolean))];

  return (
    <main className="fp-main">
      <div className="ct-kpis reveal">
        <Kpi label="Active" value={kpis.active_count + (kpis.overdue_count ? \` + \${kpis.overdue_count}⚠\` : "")}
             sub={\`\${kpis.paid_count} completed\`} icon={Activity} tone="accent" />
        <Kpi label="Total Remaining" value={rm(kpis.total_remaining)}
             sub={\`Across \${kpis.active_count + kpis.overdue_count} commitments\`} icon={ArrowDownRight} tone="neg" />
        <Kpi label="Monthly Burden" value={rm(kpis.monthly_burden)}
             sub="Recurring outflow" icon={Wallet} tone="warn" />
        <Kpi label="Total Committed" value={rm(kpis.total_committed)}
             sub="Lifetime sum" icon={CircleDollarSign} tone="pos" />
      </div>

      <div className="ct-filters card reveal" style={{animationDelay:"80ms"}}>
        <div className="ct-chips">
          {[["all","All"],["active","Active"],["overdue","Overdue"],["paid","Paid"]].map(([k,l]) => (
            <button key={k} className={\`ct-chip \${filter===k?"on":""}\`} onClick={()=>setFilter(k)}>
              {l} <span className="ct-chip-n">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="ct-buyer">
          <button className={\`ct-buyer-btn \${buyer==="all"?"on":""}\`} onClick={()=>setBuyer("all")}>Both</button>
          {buyers.map(b => (
            <button key={b} className={\`ct-buyer-btn \${buyer===b?"on":""}\`} onClick={()=>setBuyer(b)}>{b}</button>
          ))}
        </div>
        <div className="ct-search">
          <Search size={14} />
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search items…" />
        </div>
        <button className="ct-cta" onClick={()=>{setEditItem(null); setModalOpen(true);}}>
          <Plus size={14}/> New Installment
        </button>
      </div>

      {(() => {
        // Group filtered into sections based on status
        const activeOverdue = filtered.filter(i => i.status === 'active' || i.status === 'overdue');
        const paid = filtered.filter(i => i.status === 'paid');
        const showActiveOverdue = activeOverdue.length > 0;
        const showPaid = paid.length > 0;
        // Only show section dividers when filter is 'all' AND there are items in both
        const useDividers = filter === 'all' && showActiveOverdue && showPaid;

        if (filtered.length === 0) {
          return (
            <div className="ct-cards">
              <div className="ct-empty card">
                {items.length === 0 ? "No installments yet. Click \\"New Installment\\" to add your first." : "No installments match your filters."}
              </div>
            </div>
          );
        }

        if (!useDividers) {
          // Single flat grid (active-only, paid-only, overdue-only, or mixed-without-dividers)
          return (
            <div className="ct-cards">
              {filtered.map((it, idx) => (
                <InstallmentCard key={it.id} item={it} stats={computeStats(it)}
                                 expanded={expanded === it.id}
                                 onToggle={() => setExpanded(expanded === it.id ? null : it.id)}
                                 onEdit={() => handleEdit(it)} onDelete={() => handleDelete(it.id)}
                                 onPay={() => handlePay(it)} onUnpay={() => handleUnpay(it)}
                                 delay={idx * 40} />
              ))}
            </div>
          );
        }

        // Sectioned view: Active/Overdue first, then divider, then Paid
        return (
          <>
            <div className="ct-section-head">
              <Activity size={13}/>
              <span>Active &amp; Overdue</span>
              <span className="ct-section-count">{activeOverdue.length}</span>
            </div>
            <div className="ct-cards">
              {activeOverdue.map((it, idx) => (
                <InstallmentCard key={it.id} item={it} stats={computeStats(it)}
                                 expanded={expanded === it.id}
                                 onToggle={() => setExpanded(expanded === it.id ? null : it.id)}
                                 onEdit={() => handleEdit(it)} onDelete={() => handleDelete(it.id)}
                                 onPay={() => handlePay(it)} onUnpay={() => handleUnpay(it)}
                                 delay={idx * 40} />
              ))}
            </div>
            <div className="ct-section-divider"></div>
            <div className="ct-section-head">
              <CheckCircle2 size={13}/>
              <span>Paid &amp; Cleared</span>
              <span className="ct-section-count">{paid.length}</span>
            </div>
            <div className="ct-cards">
              {paid.map((it, idx) => (
                <InstallmentCard key={it.id} item={it} stats={computeStats(it)}
                                 expanded={expanded === it.id}
                                 onToggle={() => setExpanded(expanded === it.id ? null : it.id)}
                                 onEdit={() => handleEdit(it)} onDelete={() => handleDelete(it.id)}
                                 onPay={() => handlePay(it)} onUnpay={() => handleUnpay(it)}
                                 delay={idx * 40} />
              ))}
            </div>
          </>
        );
      })()}

      {modalOpen && ReactDOM.createPortal(
        <InstallmentModal onClose={()=>{setModalOpen(false); setEditItem(null);}} onSave={handleSave}
                          contributors={boot.contributors} editItem={editItem} />,
        document.body
      )}
    </main>
  );
}

function Kpi({label, value, sub, icon: Icon, tone}) {
  return (
    <div className="fp-kpi card">
      <div className="fp-kpi-top">
        <span className="fp-kpi-label">{label}</span>
        <span className={\`fp-kpi-ic \${tone}\`}><Icon size={15} /></span>
      </div>
      <div className={\`fp-kpi-val \${tone}\`}>{value}</div>
      <div className="fp-kpi-sub">{sub}</div>
    </div>
  );
}

function InstallmentCard({item, stats, expanded, onToggle, onEdit, onDelete, onPay, onUnpay, delay}) {
  const Ico = INST_ICONS[item.icon] || Package;
  const tone = item.status === "paid" ? "pos" : item.status === "overdue" ? "neg" : "active";
  const StatusIcon = item.status === "paid" ? CheckCircle2 : item.status === "overdue" ? AlertTriangle : Clock;
  const color = item.color || "var(--cyan)";
  const cells = Array.from({length: item.num_months}, (_, i) => ({
    idx: i, isPaid: i < stats.paid_months, isCurrent: i === stats.paid_months && item.status === "active"
  }));
  const canMarkPaid = item.status !== "paid";
  const canUndo = (item.paid_amount || 0) > 0 && item.status !== "paid";

  return (
    <div className={\`ct-card card \${item.status} reveal\`} style={{animationDelay:\`\${delay}ms\`}} onClick={onToggle}>
      <div className="ct-card-head">
        <div className="ct-card-ic" style={{color, background: color + "20"}}><Ico size={18} /></div>
        <div className="ct-card-name">
          <div className="ct-card-title">{item.name}</div>
          <div className="ct-card-meta">
            {item.category && <span className="ct-cat">{item.category}</span>}
            {item.buyer_name && <span className="ct-buyer-tag">{item.buyer_name}</span>}
          </div>
        </div>
        <span className={\`ct-status \${tone}\`}><StatusIcon size={11} />{item.status}</span>
      </div>
      <div className="ct-money-row">
        <div><div className="ct-money-l">Total</div><div className="ct-money-v">{rm(item.total_amount)}</div></div>
        <div><div className="ct-money-l">Monthly</div><div className="ct-money-v">{rm(item.monthly_payment)}</div></div>
        <div><div className="ct-money-l">Tenure</div><div className="ct-money-v">{item.num_months} mo</div></div>
      </div>
      <div className="ct-progress">
        <div className="ct-progress-bar">
          <div className="ct-progress-fill" style={{width:\`\${Math.min(100, stats.pct)}%\`, background: color}} />
        </div>
        <div className="ct-progress-meta">
          <span>{stats.paid_months} of {item.num_months} months paid</span>
          <span className={tone}>{Math.round(stats.pct)}%</span>
        </div>
        {stats.months_behind > 0 && (
          <div className="ct-behind">
            <AlertTriangle size={10}/>
            <span>{stats.months_behind} month{stats.months_behind > 1 ? 's' : ''} behind schedule</span>
          </div>
        )}
      </div>
      <div className="ct-bottom">
        <div>
          <div className="ct-money-l">Remaining</div>
          <div className={\`ct-big \${tone}\`}>{rm(stats.remaining)}</div>
        </div>
        <div className="ct-next">
          {item.status === "active" && <><Calendar size={11}/><span>{stats.remaining_months} months left</span></>}
          {item.status === "paid" && <><CheckCircle2 size={11}/><span>Cleared {MONTHS[(item.paid_at_month || stats.end.m)-1]} {item.paid_at_year || stats.end.y}</span></>}
          {item.status === "overdue" && <><AlertTriangle size={11}/><span>{item.num_months - stats.paid_months} pending</span></>}
        </div>
      </div>
      {canMarkPaid && (
        <div className="ct-pay-row" onClick={e => e.stopPropagation()}>
          <button className="ct-pay-btn" onClick={onPay} title="Mark next month as paid">
            <Check size={12}/> Mark {rm(item.monthly_payment)} paid
          </button>
          {canUndo && (
            <button className="ct-pay-undo" onClick={onUnpay} title="Undo last payment">
              <X size={11}/> Undo
            </button>
          )}
        </div>
      )}
      {expanded && (
        <div className="ct-detail" onClick={e => e.stopPropagation()}>
          <div className="ct-detail-head">
            <span>Payment Timeline</span>
            <div style={{display:'flex', gap:6}}>
              <button className="ct-icon-btn" onClick={onEdit} title="Edit"><Pencil size={12}/></button>
              <button className="ct-icon-btn danger" onClick={onDelete} title="Delete"><Trash2 size={12}/></button>
              <button className="ct-icon-btn" onClick={onToggle} title="Close"><X size={14}/></button>
            </div>
          </div>
          <div className="ct-timeline">
            {cells.map(c => (
              <div key={c.idx} className={\`ct-cell \${c.isPaid?"paid":c.isCurrent?"current":"pending"}\`}
                   style={c.isPaid?{background: color, borderColor: color}:{}}>
                {c.isPaid && <Check size={9} />}
              </div>
            ))}
          </div>
          <div className="ct-detail-meta">
            <span>Started {MONTHS[item.start_month-1]} {item.start_year}</span>
            <span>•</span>
            <span>Ends {MONTHS[stats.end.m-1]} {stats.end.y}</span>
            <span>•</span>
            <span>Paid {rm(stats.paid)} / {rm(item.total_amount)}</span>
            {item.notes && <><span>•</span><span>{item.notes}</span></>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== NEW / EDIT INSTALLMENT MODAL ===== */
function InstallmentModal({onClose, onSave, contributors, editItem}) {
  const isEdit = !!editItem;
  const [form, setForm] = useState(() => editItem ? {
    name: editItem.name, category: editItem.category || '', buyer_id: editItem.buyer_id || '',
    icon: editItem.icon || 'Box', color: editItem.color || 'var(--cyan)',
    total_amount: editItem.total_amount, monthly_payment: editItem.monthly_payment,
    num_months: editItem.num_months, start_year: editItem.start_year, start_month: editItem.start_month,
    paid_amount: editItem.paid_amount || 0, status: editItem.status, notes: editItem.notes || '',
    due_day: editItem.due_day != null ? editItem.due_day : 1
  } : {
    name: '', category: '', buyer_id: contributors[0]?.id || '',
    icon: 'Box', color: 'var(--cyan)', total_amount: '', monthly_payment: '', num_months: '',
    start_year: new Date().getFullYear(), start_month: new Date().getMonth()+1,
    paid_amount: 0, status: 'active', notes: '', due_day: 1
  });
  const [saving, setSaving] = useState(false);
  const upd = (k, v) => setForm(f => ({...f, [k]: v}));
  // auto-compute: when total + months entered, suggest monthly
  const autoMonthly = () => {
    if (form.total_amount && form.num_months) {
      const m = Math.round((form.total_amount / form.num_months) * 100) / 100;
      upd('monthly_payment', m);
    }
  };
  // auto-compute: total from monthly × months
  const autoTotal = () => {
    if (form.monthly_payment && form.num_months) {
      const t = Math.round(form.monthly_payment * form.num_months * 100) / 100;
      upd('total_amount', t);
    }
  };

  const submit = async () => {
    if (!form.name.trim()) return alert('Name is required');
    if (!form.total_amount || !form.monthly_payment || !form.num_months) return alert('Total, Monthly and Tenure are required');
    setSaving(true);
    try {
      await onSave({
        ...form,
        total_amount: Number(form.total_amount),
        monthly_payment: Number(form.monthly_payment),
        num_months: Number(form.num_months),
        paid_amount: Number(form.paid_amount) || 0,
        start_year: Number(form.start_year),
        start_month: Number(form.start_month),
        due_day: Math.max(1, Math.min(28, Number(form.due_day) || 1)),
        buyer_id: form.buyer_id ? Number(form.buyer_id) : null
      });
    } catch (e) { alert('Save failed: ' + e.message); setSaving(false); }
  };

  const COLORS = ["#22d3ee","#a78bfa","#34d399","#f472b6","#fbbf24","#fb7185","#60a5fa","#94a3b8"];

  return (
    <div className="ct-modal-bg" onClick={onClose}>
      <div className="ct-modal card" onClick={e=>e.stopPropagation()}>
        <div className="ct-modal-head">
          <h3>{isEdit ? 'Edit Installment' : 'New Installment'}</h3>
          <button className="ct-icon-btn" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="ct-modal-body">
          <div className="ct-field">
            <label>Item Name *</label>
            <input value={form.name} onChange={e=>upd('name', e.target.value)} placeholder="e.g. iPhone 15 Pro" autoFocus />
          </div>
          <div className="ct-row-2">
            <div className="ct-field"><label>Category</label>
              <input value={form.category} onChange={e=>upd('category', e.target.value)} placeholder="Electronics, Furniture…" /></div>
            <div className="ct-field"><label>Buyer</label>
              <select value={form.buyer_id} onChange={e=>upd('buyer_id', e.target.value)}>
                <option value="">— None —</option>
                {contributors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
          </div>
          <div className="ct-row-3">
            <div className="ct-field"><label>Total Amount (RM) *</label>
              <FmtInput value={form.total_amount}
                     onChange={e=>upd('total_amount', e.target.value)} onBlur={autoMonthly} placeholder="0.00"/></div>
            <div className="ct-field"><label>Monthly (RM) *</label>
              <FmtInput value={form.monthly_payment}
                     onChange={e=>upd('monthly_payment', e.target.value)} onBlur={autoTotal} placeholder="0.00"/></div>
            <div className="ct-field"><label>Tenure (months) *</label>
              <input type="number" value={form.num_months}
                     onChange={e=>upd('num_months', e.target.value)} onBlur={autoMonthly} placeholder="24"/></div>
          </div>
          <div className="ct-row-3">
            <div className="ct-field"><label>Start Year</label>
              <input type="number" value={form.start_year} onChange={e=>upd('start_year', e.target.value)}/></div>
            <div className="ct-field"><label>Start Month</label>
              <select value={form.start_month} onChange={e=>upd('start_month', e.target.value)}>
                {MONTHS.map((m, i) => <option key={m} value={i+1}>{m}</option>)}
              </select></div>
            <div className="ct-field"><label>Due day (1-28)</label>
              <input type="number" min="1" max="28" value={form.due_day}
                     onChange={e=>upd('due_day', e.target.value)} placeholder="1"/></div>
          </div>
          <div className="ct-row-2">
            <div className="ct-field"><label>Status</label>
              <select value={form.status} onChange={e=>upd('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
              </select></div>
            <div className="ct-field"><label>Paid So Far (override, optional)</label>
              <FmtInput value={form.paid_amount}
                     onChange={e=>upd('paid_amount', e.target.value)} placeholder="0"/></div>
          </div>
          <div className="ct-row-2">
            <div className="ct-field"><label>Icon</label>
              <div className="ct-icon-grid">
                {INST_ICON_LIST.map(name => {
                  const I = INST_ICONS[name];
                  return (
                    <button key={name} className={\`ct-icon-pick \${form.icon===name?"on":""}\`}
                            onClick={()=>upd('icon', name)} title={name}>
                      <I size={15} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ct-field"><label>Color</label>
              <div className="ct-color-grid">
                {COLORS.map(c => (
                  <button key={c} className={\`ct-color-pick \${form.color===c?"on":""}\`}
                          style={{background: c}} onClick={()=>upd('color', c)} />
                ))}
              </div>
            </div>
          </div>
          <div className="ct-field"><label>Notes</label>
            <input value={form.notes} onChange={e=>upd('notes', e.target.value)} placeholder="Optional notes…"/></div>
        </div>
        <div className="ct-modal-foot">
          <button className="ct-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="ct-btn-solid" onClick={submit} disabled={saving}>
            <Check size={14}/> {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Installment'}
          </button>
        </div>
      </div>
    </div>
  );
}
</script>
</body>
</html>
`;