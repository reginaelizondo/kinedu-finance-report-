/* ============================================================
 * kinedu-data.js — shared Google Sheets data layer
 *
 * Single source of truth for the live-sheet fetch logic used by
 * both dashboards (index.html and investors.html). Before this
 * file existed the parsers, label maps and merge logic were
 * copy-pasted in both files and every fix had to land twice.
 *
 * Exposes one global: window.KineduData
 * ============================================================ */
(function () {
    'use strict';

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const SHEETS = {
        // P&L ACC 2026 — Consolidated Income Statement
        acc: 'https://docs.google.com/spreadsheets/d/1R8KtpYwMHsBxAREwyMjp4T_lYE2GCBEW6ThXipdXhZQ/export?format=csv&gid=1030223001',
        // KPIs 2026 — marketing spend, signups, subscriptions, conversion
        kpi: 'https://docs.google.com/spreadsheets/d/1ptCjNZlmwUkSupP5uQlXtS3SMZjpciBQv893oCkkdVA/export?format=csv&gid=82873067'
    };

    // Sheet row label → dashboard field. ACC months start at column 2
    // (blank gutter column), KPI months start at column 1.
    const ACC_LABEL_MAP = {
        'MRR': 'mrr',
        'Partnerships': 'partnerships',
        'Gross Revenue': 'grossRevenue',
        '-Comisiones(Google,Apple,Stripe)': 'commissions',
        'Net Revenue': 'netRevenue',
        'Hosting & Cloud Infrastructure': 'servers',
        'Gross Profit': 'grossProfit',
        'Paid Acquisition (Ads, SEO, etc.)': 'paidAcquisition',
        'UGC´s': 'mktOthers',
        'Total CAC': 'totalCAC',
        'Contribution Profit': 'contributionProfit',
        'Total Operating Expenses': 'totalOpex',
        'EBITDA': 'ebitda',
        // "Gross Margin %" appears twice in the sheet (row 21 vs net revenue,
        // row 82 vs gross revenue). Last match wins → row 82, which matches
        // the hardcoded fallbacks.
        'Gross Margin %': 'grossMarginPctSheet',
        'Contribution margin %': 'contribMarginPctSheet',
        'EBITDA margin %': 'ebitdaMarginPctSheet'
    };

    const KPI_LABEL_MAP = {
        'Spend': 'spend',
        'Signups': 'signups',
        'CPNU (Without Retargeting)': 'cpnu',
        'New Subscriptions': 'subs',
        'Conversion Rate': 'conversion'
    };

    // Freshness metadata, consumed by the "Live data" indicator.
    const freshness = {
        fetchedAt: null,        // Date of the last successful fetch (either sheet)
        accMonths: 0,           // months with ACC data
        kpiMonths: 0,           // months with KPI data
        latestMonthIdx: -1,     // 0-based index of the latest month with ACC actuals
        live: false             // true once at least one sheet loaded
    };

    function parseMoneyCell(raw) {
        if (raw == null) return 0;
        const s = String(raw).trim();
        if (!s || s === '-' || s === '$' || s === '$-' || s === '$ -') return 0;
        const negative = s.startsWith('-');
        // Strip $, comma, %, whitespace — handles "$1,234", "-$1,234", "7.83%"
        const n = parseFloat(s.replace(/[\$,%\s]/g, '').replace(/^-/, ''));
        return isNaN(n) ? 0 : (negative ? -n : n);
    }

    function parseCsvRows(text) {
        const rows = [];
        for (const line of text.split(/\r?\n/)) {
            const row = [];
            let cur = '', inQ = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (c === '"') { inQ = !inQ; continue; }
                if (c === ',' && !inQ) { row.push(cur); cur = ''; continue; }
                cur += c;
            }
            row.push(cur);
            rows.push(row);
        }
        return rows;
    }

    // Generic fetcher: downloads a sheet CSV, matches rows by label and
    // returns { January: {field: value, ...}, ... } or null on failure.
    async function fetchSheetActuals({ url, labelMap, colOffset, name }) {
        try {
            const csv = await fetch(url, { cache: 'no-store' }).then(r => r.text());
            const rows = parseCsvRows(csv);
            const out = {};
            MONTHS.forEach(m => { out[m] = {}; });
            let matched = 0;
            rows.forEach(r => {
                const field = labelMap[(r[0] || '').trim()];
                if (!field) return;
                matched++;
                MONTHS.forEach((m, idx) => {
                    out[m][field] = parseMoneyCell(r[idx + colOffset]);
                });
            });
            if (matched === 0) {
                console.warn(`${name} sheet: no matching labels — keeping hardcoded values`);
                return null;
            }
            console.log(`${name} sheet: matched ${matched} rows`);
            return out;
        } catch (e) {
            console.warn(`${name} sheet fetch failed, falling back to hardcoded:`, e);
            return null;
        }
    }

    const fetchAccActuals = () => fetchSheetActuals({
        url: SHEETS.acc, labelMap: ACC_LABEL_MAP, colOffset: 2, name: 'ACC'
    });
    const fetchKpiActuals = () => fetchSheetActuals({
        url: SHEETS.kpi, labelMap: KPI_LABEL_MAP, colOffset: 1, name: 'KPI'
    });

    // Merge sheet data into a hardcoded constant. Only overwrites months
    // where the sheet had a non-zero value somewhere — blank months never
    // blank out the hardcoded fallbacks. Returns # of months touched.
    function mergeMonthly(target, src, opts) {
        if (!src || !target) return 0;
        let monthsTouched = 0;
        MONTHS.forEach((month, idx) => {
            if (!target[month] || !src[month]) return;
            const hasAny = Object.values(src[month]).some(v => v !== 0);
            if (!hasAny) return;
            Object.assign(target[month], src[month]);
            monthsTouched++;
            if (opts && opts.trackLatest && idx > freshness.latestMonthIdx) {
                freshness.latestMonthIdx = idx;
            }
        });
        return monthsTouched;
    }

    // Fetch both sheets in parallel and merge into the given targets.
    // Returns { accTouched, kpiTouched } and updates freshness metadata.
    async function refreshActuals({ accTarget, kpiTarget }) {
        const [accSheet, kpiSheet] = await Promise.all([
            accTarget ? fetchAccActuals() : null,
            kpiTarget ? fetchKpiActuals() : null
        ]);
        const accTouched = accTarget ? mergeMonthly(accTarget, accSheet, { trackLatest: true }) : 0;
        const kpiTouched = kpiTarget ? mergeMonthly(kpiTarget, kpiSheet) : 0;
        if (accTouched || kpiTouched) {
            freshness.fetchedAt = new Date();
            freshness.accMonths = accTouched;
            freshness.kpiMonths = kpiTouched;
            freshness.live = true;
        }
        return { accTouched, kpiTouched };
    }

    // Human label for the freshness pill, e.g. "Live · through Apr '26".
    function freshnessLabel() {
        if (!freshness.live) return 'Cached data';
        if (freshness.latestMonthIdx < 0) return 'Live data';
        const yy = String(new Date().getFullYear()).slice(2);
        return `Live · through ${MONTHS_SHORT[freshness.latestMonthIdx]} '${yy}`;
    }

    window.KineduData = {
        MONTHS, MONTHS_SHORT, SHEETS,
        parseMoneyCell, parseCsvRows,
        fetchSheetActuals, fetchAccActuals, fetchKpiActuals,
        mergeMonthly, refreshActuals,
        freshness, freshnessLabel
    };
})();
