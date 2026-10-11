/* ============================================================
   BALANCÍMETRO · app.js
   Controle financeiro para motoristas de entregas/fretes.
   Tudo em LocalStorage, 100% offline.
============================================================ */

(() => {
  'use strict';

  /* ---------------------------------------------------------
     1. CONSTANTES E TABELAS DE PREÇO
  --------------------------------------------------------- */

  const STORAGE_KEYS = {
    SETTINGS: 'rc_settings',
    DAYS: 'rc_days',          // { 'YYYY-MM-DD': DayRecord }
    FUEL: 'rc_fuel_history',  // [ FuelRecord ]
    THEME: 'rc_theme'         // 'orange' | 'dark'
  };

  // Tabela de valor por KM, por tipo de veículo e faixa de KM.
  // Cada faixa é avaliada pelo KM TOTAL da rota (não progressivo).
  const RATE_TABLE = {
    // Tabela de frete vigente desde 01/09/2026.
    passeio: [
      { max: 100, value: 228.11 },
      { max: 150, value: 260.66 },
      { max: 200, value: 297.98 },
      { max: 300, value: 335.20 },
      { max: Infinity, value: 367.75 }
    ],
    utilitario: [
      { max: 100, value: 288.50 },
      { max: 150, value: 330.44 },
      { max: 200, value: 376.95 },
      { max: 300, value: 418.89 },
      { max: Infinity, value: 465.40 }
    ],
    van: [
      { max: 100, value: 393.14 },
      { max: 150, value: 452.17 },
      { max: 200, value: 511.19 },
      { max: 300, value: 571.27 },
      { max: Infinity, value: 630.29 }
    ],
    vuc: [
      { max: 100, value: 580.83 },
      { max: 150, value: 628.72 },
      { max: 200, value: 687.83 },
      { max: 300, value: 708.21 },
      { max: Infinity, value: 762.21 }
    ],
    // "Luxo" não consta na tabela da cooperativa.
    // Usamos um multiplicador sobre a tabela "van" como estimativa,
    // mantendo a mesma lógica de faixas.
    luxo: [
      { max: 100, value: 393.14 * 1.35 },
      { max: 150, value: 452.17 * 1.35 },
      { max: 200, value: 511.19 * 1.35 },
      { max: 300, value: 571.27 * 1.35 },
      { max: Infinity, value: 630.29 * 1.35 }
    ]
  };

  const VEHICLE_LABELS = {
    passeio: 'Passeio',
    utilitario: 'Utilitário',
    van: 'Van',
    vuc: 'VUC',
    luxo: 'Luxo'
  };

  // Adicional padrão de domingo/feriado (%). Pode ser trocado, rota a rota,
  // pelo lápis no modal de Nova Rota (ex.: dias em que pagam +30% ou +50%).
  const FERIADO_PCT_PADRAO = 20;

  // Retenções obrigatórias da cooperativa, incidentes sobre o faturamento bruto.
  const RATEIO_ADM_RATE = 0.08;   // 8,0%
  const INSS_RATE = 0.04;         // 4,0%
  const SEST_SENAT_RATE = 0.005;  // 0,5%
  const RETENCOES_RATE = RATEIO_ADM_RATE + INSS_RATE + SEST_SENAT_RATE; // 12,5%

  /* ---------------------------------------------------------
     2. UTILITÁRIOS
  --------------------------------------------------------- */

  const fmtBRL = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const fmtKM = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
  };

  const fmtPct = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  };

  const todayKey = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const parseKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const fmtDateLabel = (key) => {
    const d = parseKey(key);
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
  };

  const fmtDateShort = (key) => {
    const d = parseKey(key);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  // Texto digitado pelo usuário (nome/ID da rota) entra no HTML dos cartões,
  // então sempre passa por aqui antes, para não quebrar a tela.
  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Etiquetas com o nome e o ID da rota (vazio se a rota não tiver nenhum).
  const routeChipsHtml = (r) => {
    const nome = r && r.nomeRota ? String(r.nomeRota).trim() : '';
    const idRota = r && r.idRota ? String(r.idRota).trim() : '';
    if (!nome && !idRota) return '';
    return `<div class="route-chips">${
      nome ? `<span class="route-chip">${escapeHtml(nome)}</span>` : ''
    }${
      idRota ? `<span class="route-chip route-chip--id">ID ${escapeHtml(idRota)}</span>` : ''
    }</div>`;
  };

  const clampNum = (v, fallback = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /* ---------------------------------------------------------
     3. PERSISTÊNCIA (LocalStorage)
  --------------------------------------------------------- */

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (e) {
      console.warn('Falha ao ler', key, e);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Falha ao salvar', key, e);
      return false;
    }
  }

  const defaultSettings = () => ({
    vehicle: 'passeio'
  });

  let state = {
    settings: loadJSON(STORAGE_KEYS.SETTINGS, defaultSettings()),
    days: loadJSON(STORAGE_KEYS.DAYS, {}),
    fuel: loadJSON(STORAGE_KEYS.FUEL, [])
  };

  function persistSettings() { saveJSON(STORAGE_KEYS.SETTINGS, state.settings); }
  function persistDays() { saveJSON(STORAGE_KEYS.DAYS, state.days); }
  function persistFuel() { saveJSON(STORAGE_KEYS.FUEL, state.fuel); }

  /* ---------------------------------------------------------
     4. MODELO DE DIA
     DayRecord = {
       kmInicial: number|null,
       kmFinal: number|null,
       gastosExtra: number,
       encerrado: boolean,
       routes: [ RouteRecord ]
     }
     RouteRecord = {
       id, km, paradas, feriado, vehicle, consumo,
       valorKm, valorParadas, faturamento,
       combustivel, lucro, precoUsado, createdAt
     }
  --------------------------------------------------------- */

  function getDay(key) {
    if (!state.days[key]) {
      state.days[key] = {
        kmInicial: null,
        kmFinal: null,
        gastosExtra: 0,
        encerrado: false,
        routes: []
      };
    }
    return state.days[key];
  }

  function ensureDayExists(key) {
    if (!state.days[key]) {
      state.days[key] = {
        kmInicial: null,
        kmFinal: null,
        gastosExtra: 0,
        encerrado: false,
        routes: []
      };
      persistDays();
    }
    return state.days[key];
  }

  /* ---------------------------------------------------------
     5. REGRAS DE CÁLCULO
  --------------------------------------------------------- */

  // 5.1 Valor por KM, conforme veículo e faixa total da rota
  function calcValorKm(vehicle, km) {
    const table = RATE_TABLE[vehicle] || RATE_TABLE.passeio;
    const faixa = table.find(f => km <= f.max) || table[table.length - 1];
    return faixa.value;
  }

  // 5.2 Valor das paradas (faixas progressivas)
  // 1-60: R$0,44 cada
  // 61-90: R$1,16 cada (somente o excedente acima de 60)
  // >91: R$0,53 cada (somando faixas anteriores)
  function calcValorParadas(paradas) {
    const n = Math.max(0, Math.floor(paradas || 0));
    let total = 0;

    const faixa1 = Math.min(n, 60);
    total += faixa1 * 0.44;

    if (n > 60) {
      const faixa2 = Math.min(n - 60, 30); // 61 a 90 => até 30 paradas nessa faixa
      total += faixa2 * 1.16;
    }

    if (n > 90) {
      const faixa3 = n - 90;
      total += faixa3 * 0.53;
    }

    return total;
  }

  // 5.3 Preço por litro do combustível: usa o valor do abastecimento mais
  // recente registrado no histórico (tela de Abastecimentos). Se ainda não
  // houver nenhum abastecimento, usa um valor padrão de fallback.
  const FALLBACK_PRECO_COMBUSTIVEL = 5.89;

  function getLastFuelPrice() {
    if (!state.fuel || state.fuel.length === 0) {
      return { preco: FALLBACK_PRECO_COMBUSTIVEL, tipo: null, hasHistorico: false };
    }
    // O histórico é populado em ordem cronológica; o último item é o
    // abastecimento mais recente.
    const last = state.fuel[state.fuel.length - 1];
    return { preco: clampNum(last.preco, FALLBACK_PRECO_COMBUSTIVEL), tipo: last.tipo, hasHistorico: true };
  }

  // 5.4 Combustível estimado de uma rota: KM da rota ÷ consumo informado,
  // multiplicado pelo preço por litro do último abastecimento.
  function calcCombustivelRota(km, consumo, precoCombustivel) {
    const c = clampNum(consumo, 0);
    const p = clampNum(precoCombustivel, 0);
    if (c <= 0) return 0;
    const litros = km / c;
    return litros * p;
  }

  // 5.4b Retenções obrigatórias da cooperativa (rateio administrativo,
  // INSS e SEST/SENAT), sempre calculadas sobre o faturamento BRUTO.
  function calcRetencoes(faturamento) {
    const bruto = clampNum(faturamento, 0);
    const rateioAdm = bruto * RATEIO_ADM_RATE;
    const inss = bruto * INSS_RATE;
    const sestSenat = bruto * SEST_SENAT_RATE;
    const total = rateioAdm + inss + sestSenat; // = bruto * RETENCOES_RATE
    return { rateioAdm, inss, sestSenat, total };
  }

  // 5.5 Cálculo completo de uma rota: faturamento, combustível e lucro.
  // O adicional de domingo/feriado (padrão +20%, ajustável por rota) incide
  // APENAS sobre o valor do KM. O valor das paradas nunca recebe adicional.
  function calcRoute({ km, paradas, feriado, feriadoPct = FERIADO_PCT_PADRAO, vehicle, consumo }) {
    const valorKm = calcValorKm(vehicle, km);
    const valorParadas = calcValorParadas(paradas);
    const multiplicador = 1 + Math.max(0, clampNum(feriadoPct, FERIADO_PCT_PADRAO)) / 100;
    const valorKmComAdicional = feriado ? valorKm * multiplicador : valorKm;
    const faturamento = valorKmComAdicional + valorParadas;

    const { preco: precoCombustivel } = getLastFuelPrice();
    const combustivel = calcCombustivelRota(km, consumo, precoCombustivel);
    const retencoes = calcRetencoes(faturamento);
    const lucro = faturamento - combustivel - retencoes.total;

    return { valorKm, valorParadas, faturamento, combustivel, retencoes, lucro, precoUsado: precoCombustivel };
  }

  // 5.6 Totais de um dia: soma o faturamento, combustível e lucro de cada
  // rota já calculados individualmente (cada rota usa seu próprio consumo).
  // Compatibilidade com rotas salvas em versões anteriores do app, que
  // usavam um único campo "total" (sem separar combustível/lucro por
  // rota). Garante que toda rota lida do armazenamento tenha sempre os
  // campos atuais preenchidos, independente de quando foi criada.
  function normalizeRoute(r) {
    if (r.faturamento != null && r.combustivel != null && r.lucro != null) {
      return r; // já está no formato atual
    }
    const faturamento = r.faturamento != null ? r.faturamento : (r.total != null ? r.total : 0);
    const combustivel = r.combustivel != null ? r.combustivel : 0;
    const lucro = r.lucro != null ? r.lucro : (faturamento - combustivel);
    return { ...r, faturamento, combustivel, lucro };
  }

  function calcDayTotals(dayKey) {
    const day = state.days[dayKey];
    if (!day) {
      return { faturamento: 0, kmRodado: 0, combustivel: 0, lucro: 0, rotas: 0, gastosExtra: 0 };
    }

    const routes = day.routes.map(normalizeRoute);
    const faturamento = routes.reduce((acc, r) => acc + r.faturamento, 0);
    const combustivelRotas = routes.reduce((acc, r) => acc + r.combustivel, 0);
    const rotas = routes.length;
    const gastosExtra = clampNum(day.gastosExtra, 0);

    let kmRodado = 0;
    if (day.kmInicial != null && day.kmFinal != null && day.kmFinal >= day.kmInicial) {
      kmRodado = day.kmFinal - day.kmInicial;
    } else {
      // Fallback: soma o KM das rotas registradas, caso o motorista não tenha
      // usado o fluxo de odômetro inicial/final.
      kmRodado = routes.reduce((acc, r) => acc + (r.km || 0), 0);
    }

    const lucro = faturamento - combustivelRotas - calcRetencoes(faturamento).total - gastosExtra;

    return { faturamento, kmRodado, combustivel: combustivelRotas, lucro, rotas, gastosExtra };
  }

  // 5.7 Quinzena: fechamento fixo no calendário de cada mês.
  // 1ª quinzena: dia 01 ao dia 15. 2ª quinzena: dia 16 ao último dia do mês
  // (28, 29, 30 ou 31, dependendo do mês).
  function getQuinzenaRange(referenceDate = new Date()) {
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const day = referenceDate.getDate();

    if (day <= 15) {
      return {
        start: new Date(year, month, 1),
        end: new Date(year, month, 15)
      };
    }

    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    return {
      start: new Date(year, month, 16),
      end: new Date(year, month, lastDayOfMonth)
    };
  }

  function calcQuinzenaTotals(referenceDate = new Date()) {
    const { start, end } = getQuinzenaRange(referenceDate);
    let faturamento = 0, combustivelEstimado = 0, gastosExtra = 0, rotas = 0, kmRodado = 0, diasComMovimento = 0;

    const cursor = new Date(start);
    while (cursor <= end) {
      const key = todayKey(cursor);
      if (state.days[key]) {
        const t = calcDayTotals(key);
        faturamento += t.faturamento;
        combustivelEstimado += t.combustivel;
        gastosExtra += t.gastosExtra;
        rotas += t.rotas;
        kmRodado += t.kmRodado;
        if (t.rotas > 0 || t.kmRodado > 0) diasComMovimento++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    // Na quinzena o combustível NÃO é o consumo estimado das rotas: é o que
    // o motorista realmente abasteceu (tela de Abastecimentos) dentro do
    // período, do primeiro ao último dia da quinzena.
    const startKey = todayKey(start);
    const endKey = todayKey(end);
    const combustivel = (state.fuel || [])
      .filter(f => f.date >= startKey && f.date <= endKey)
      .reduce((acc, f) => acc + clampNum(f.valor, 0), 0);

    const retencoes = calcRetencoes(faturamento);
    const lucro = faturamento - retencoes.total - combustivel - gastosExtra;

    return {
      start, end, faturamento,
      combustivel,            // total abastecido na quinzena
      combustivelEstimado,    // soma do consumo estimado das rotas (referência)
      gastosExtra, retencoes, lucro, rotas, kmRodado, diasComMovimento
    };
  }

  // 5.7 Série temporal agregada para os gráficos (dia / semana / mês).
  // Retorna os últimos N pontos (mais antigo -> mais recente), cada um com
  // { label, km, lucro, combustivel }.
  function buildChartSeries(period) {
    const allKeys = Object.keys(state.days).sort();
    if (allKeys.length === 0) return [];

    const dayTotalsCache = {};
    const getTotals = (key) => {
      if (!dayTotalsCache[key]) dayTotalsCache[key] = calcDayTotals(key);
      return dayTotalsCache[key];
    };

    if (period === 'dia') {
      // Últimos 14 dias corridos (mostra todos, mesmo sem movimento, para
      // dar noção de continuidade no eixo do tempo).
      const today = new Date();
      const points = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = todayKey(d);
        const t = state.days[key]
          ? getTotals(key)
          : { kmRodado: 0, lucro: 0, combustivel: 0, faturamento: 0, rotas: 0 };
        points.push({
          label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          fullLabel: d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }),
          km: t.kmRodado, lucro: t.lucro, combustivel: t.combustivel,
          faturamento: t.faturamento, rotas: t.rotas
        });
      }
      return points;
    }

    if (period === 'semana') {
      // Agrupa por semana (segunda a domingo), últimas 8 semanas.
      const today = new Date();
      const startOfWeek = (d) => {
        const x = new Date(d);
        const day = x.getDay(); // 0=domingo
        const diff = (day === 0 ? -6 : 1 - day); // volta até segunda
        x.setDate(x.getDate() + diff);
        x.setHours(0, 0, 0, 0);
        return x;
      };

      const weeks = [];
      const thisWeekStart = startOfWeek(today);
      for (let i = 7; i >= 0; i--) {
        const ws = new Date(thisWeekStart);
        ws.setDate(ws.getDate() - i * 7);
        const we = new Date(ws);
        we.setDate(we.getDate() + 6);
        weeks.push({ start: ws, end: we });
      }

      return weeks.map(({ start, end }) => {
        let km = 0, lucro = 0, combustivel = 0, faturamento = 0, rotas = 0;
        const cursor = new Date(start);
        while (cursor <= end) {
          const key = todayKey(cursor);
          if (state.days[key]) {
            const t = getTotals(key);
            km += t.kmRodado; lucro += t.lucro; combustivel += t.combustivel;
            faturamento += t.faturamento; rotas += t.rotas;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        const label = `${start.getDate()}/${start.getMonth() + 1}`;
        const fullLabel = `${start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} – ${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
        return { label, fullLabel, km, lucro, combustivel, faturamento, rotas };
      });
    }

    // period === 'mes': agrupa por mês corrido, últimos 6 meses.
    const today = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      months.push(d);
    }

    return months.map((monthDate) => {
      let km = 0, lucro = 0, combustivel = 0, faturamento = 0, rotas = 0;
      const y = monthDate.getFullYear();
      const m = monthDate.getMonth();
      allKeys.forEach((key) => {
        const d = parseKey(key);
        if (d.getFullYear() === y && d.getMonth() === m) {
          const t = getTotals(key);
          km += t.kmRodado; lucro += t.lucro; combustivel += t.combustivel;
          faturamento += t.faturamento; rotas += t.rotas;
        }
      });
      const label = monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
      const fullLabel = monthDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return { label, fullLabel, km, lucro, combustivel, faturamento, rotas };
    });
  }

  /* ---------------------------------------------------------
     6. REFERÊNCIAS DE DOM
  --------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    // home
    heroQuinzena: $('#hero-quinzena'),
    heroPeriodo: $('#hero-periodo'),
    statLucroHoje: $('#stat-lucro-hoje'),
    statKmHoje: $('#stat-km-hoje'),
    statFuelHoje: $('#stat-fuel-hoje'),
    statRotasHoje: $('#stat-rotas-hoje'),
    dayDate: $('#day-date'),
    kmRow: $('#km-row'),
    routeList: $('#route-list'),
    btnOpenFuel: $('#btn-open-fuel'),
    btnOpenSettings: $('#btn-open-settings'),
    btnToggleTheme: $('#btn-toggle-theme'),
    btnAddRoute: $('#btn-add-route'),
    btnFinishDay: $('#btn-finish-day'),

    // tabs / screens
    tabs: $$('.tab'),
    screens: $$('.screen'),
    backBtns: $$('[data-back]'),

    // settings
    cfgVehicle: $('#cfg-vehicle'),
    btnSaveSettings: $('#btn-save-settings'),

    // fuel
    fuelType: $('#fuel-type'),
    fuelValor: $('#fuel-valor'),
    fuelPreco: $('#fuel-preco'),
    fuelLitrosPreview: $('#fuel-litros-preview'),
    btnAddFuel: $('#btn-add-fuel'),
    fuelList: $('#fuel-list'),

    // history
    historySegmented: $('#history-segmented'),
    historyBody: $('#history-body'),

    // charts
    chartsSegmented: $('#charts-segmented'),
    chartCanvas: $('#km-chart'),
    chartsSummary: $('#charts-summary'),

    // modal: rota
    modalRoute: $('#modal-route'),
    routeKm: $('#route-km'),
    routeParadas: $('#route-paradas'),
    routeConsumo: $('#route-consumo'),
    routeNome: $('#route-nome'),
    routeIdRota: $('#route-id'),
    routeFeriado: $('#route-feriado'),
    routeFeriadoLabel: $('#route-feriado-label'),
    btnEditFeriadoPct: $('#btn-edit-feriado-pct'),
    feriadoPctField: $('#feriado-pct-field'),
    routeFeriadoPct: $('#route-feriado-pct'),
    routeModalDate: $('#route-modal-date'),
    prevKmVal: $('#prev-km-val'),
    prevParadasVal: $('#prev-paradas-val'),
    prevTotalVal: $('#prev-total-val'),
    prevFuelVal: $('#prev-fuel-val'),
    prevFuelInfo: $('#prev-fuel-info'),
    prevTaxasVal: $('#prev-taxas-val'),
    prevLucroVal: $('#prev-lucro-val'),
    btnSaveRoute: $('#btn-save-route'),
    btnCancelRoute: $('#btn-cancel-route'),

    // modal: backup
    btnOpenBackup: $('#btn-open-backup'),
    modalBackup: $('#modal-backup'),
    btnBackupDownload: $('#btn-backup-download'),
    btnBackupUpload: $('#btn-backup-upload'),
    btnBackupCancel: $('#btn-backup-cancel'),
    backupFile: $('#backup-file'),

    // modal: rotas da quinzena
    modalQuinzenaRoutes: $('#modal-quinzena-routes'),
    qrPeriodLabel: $('#qr-period-label'),
    qrList: $('#qr-list'),
    btnCloseQuinzenaRoutes: $('#btn-close-quinzena-routes'),

    // modal: confirmação
    modalConfirm: $('#modal-confirm'),
    confirmTitle: $('#confirm-title'),
    confirmMessage: $('#confirm-message'),
    btnConfirmOk: $('#btn-confirm-ok'),
    btnConfirmCancel: $('#btn-confirm-cancel'),

    // modal: detalhamento da quinzena
    modalQuinzenaDetail: $('#modal-quinzena-detail'),
    qdPeriodLabel: $('#qd-period-label'),
    qdBrutoVal: $('#qd-bruto-val'),
    qdFuelVal: $('#qd-fuel-val'),
    qdFuelPct: $('#qd-fuel-pct'),
    qdRateioVal: $('#qd-rateio-val'),
    qdInssVal: $('#qd-inss-val'),
    qdSestVal: $('#qd-sest-val'),
    qdExtraRow: $('#qd-extra-row'),
    qdExtraVal: $('#qd-extra-val'),
    qdDescontosVal: $('#qd-descontos-val'),
    qdDescontosPct: $('#qd-descontos-pct'),
    qdLiquidoVal: $('#qd-liquido-val'),
    qdLiquidoPct: $('#qd-liquido-pct'),
    btnCloseQuinzenaDetail: $('#btn-close-quinzena-detail'),

    // modal: km inicial
    modalKmStart: $('#modal-km-start'),
    kmInicialInput: $('#km-inicial-input'),
    btnSaveKmStart: $('#btn-save-km-start'),
    btnCancelKmStart: $('#btn-cancel-km-start'),

    // modal: km final
    modalKmEnd: $('#modal-km-end'),
    kmEndInfo: $('#km-end-info'),
    kmFinalInput: $('#km-final-input'),
    gastosExtraInput: $('#gastos-extra-input'),
    btnSaveKmEnd: $('#btn-save-km-end'),
    btnCancelKmEnd: $('#btn-cancel-km-end'),

    toast: $('#toast')
  };

  /* ---------------------------------------------------------
     7. TOAST
  --------------------------------------------------------- */

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('toast--show'), 2200);
  }

  /* ---------------------------------------------------------
     8. NAVEGAÇÃO ENTRE TELAS
  --------------------------------------------------------- */

  function goToScreen(name) {
    const map = {
      home: '#screen-home',
      history: '#screen-history',
      settings: '#screen-settings',
      fuel: '#screen-fuel',
      charts: '#screen-charts'
    };
    els.screens.forEach(s => s.classList.remove('screen--active'));
    const target = document.querySelector(map[name]);
    if (target) target.classList.add('screen--active');

    els.tabs.forEach(t => t.classList.toggle('tab--active', t.dataset.tab === name));

    if (name === 'history') renderHistory();
    if (name === 'settings') fillSettingsForm();
    if (name === 'fuel') renderFuelList();
    if (name === 'home') renderHome();
    if (name === 'charts') renderCharts();
  }

  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => goToScreen(tab.dataset.tab));
  });
  els.backBtns.forEach(btn => {
    btn.addEventListener('click', () => goToScreen(btn.dataset.back));
  });
  els.btnOpenFuel.addEventListener('click', () => goToScreen('fuel'));
  els.btnOpenSettings.addEventListener('click', () => goToScreen('settings'));

  /* ---------------------------------------------------------
     8b. TEMA (alternado pelo ponto no logo, no topo da Home)
     Persistido em LocalStorage para lembrar a escolha entre visitas.
  --------------------------------------------------------- */

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#14171C' : '#1A0E08');
    }
  }

  function loadTheme() {
    try {
      return localStorage.getItem(STORAGE_KEYS.THEME) || 'orange';
    } catch (e) {
      return 'orange';
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEYS.THEME, theme);
    } catch (e) {
      console.warn('Falha ao salvar tema', e);
    }
  }

  let currentTheme = loadTheme();
  applyTheme(currentTheme);

  if (els.btnToggleTheme) {
    els.btnToggleTheme.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'orange' : 'dark';
      applyTheme(currentTheme);
      saveTheme(currentTheme);
    });
  }

  /* ---------------------------------------------------------
     9. RENDER: HOME
  --------------------------------------------------------- */

  function renderHome() {
    const todayK = todayKey();
    const day = state.days[todayK];

    // Quinzena
    const q = calcQuinzenaTotals();
    els.heroQuinzena.textContent = fmtBRL(q.lucro);
    els.heroQuinzena.style.color = q.lucro < 0 ? 'var(--danger)' : '';
    const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    els.heroPeriodo.textContent = `${startLabel} a ${endLabel} \u00B7 ${q.rotas} rota${q.rotas === 1 ? '' : 's'}`;

    // Dia atual
    const t = calcDayTotals(todayK);
    els.statLucroHoje.textContent = fmtBRL(t.lucro);
    els.statKmHoje.textContent = fmtKM(t.kmRodado);
    els.statFuelHoje.textContent = fmtBRL(t.combustivel);
    els.statRotasHoje.textContent = String(t.rotas);

    els.dayDate.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

    renderKmRow(day);
    renderRouteList(day);
  }

  function renderKmRow(day) {
    // Botões de "Registrar KM inicial" e "Encerrar dia (KM final)" foram
    // removidos da tela "Hoje". O KM rodado agora é calculado sempre pela
    // soma do KM de cada rota (ver fallback em calcDayTotals).
    els.kmRow.innerHTML = '';
  }

  function renderRouteList(day) {
    els.routeList.innerHTML = '';
    if (!day || day.routes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhuma rota registrada hoje ainda.';
      els.routeList.appendChild(empty);
      return;
    }

    day.routes.slice().reverse().map(normalizeRoute).forEach((r) => {
      const item = document.createElement('div');
      item.className = 'route-item';
      item.innerHTML = `
        <div class="route-item__info">
          ${routeChipsHtml(r)}
          <span class="route-item__title">${r.km} km \u00B7 ${r.paradas} parada${r.paradas === 1 ? '' : 's'}</span>
          <span class="route-item__meta">Bruto ${fmtBRL(r.faturamento)} \u00B7 Combust. ${fmtBRL(r.combustivel)}${r.feriado ? ` \u00B7 Feriado (+${fmtPctInt(r.feriadoPct != null ? r.feriadoPct : FERIADO_PCT_PADRAO)}%)` : ''}</span>
        </div>
        <span class="route-item__value" style="${r.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(r.lucro)}</span>
        <button class="route-item__del" data-id="${r.id}" aria-label="Remover rota">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      `;
      els.routeList.appendChild(item);
    });

    els.routeList.querySelectorAll('.route-item__del').forEach(btn => {
      btn.addEventListener('click', () => removeRoute(btn.dataset.id));
    });
  }

  function removeRoute(id) {
    const key = todayKey();
    const day = state.days[key];
    if (!day) return;
    day.routes = day.routes.filter(r => r.id !== id);
    persistDays();
    renderHome();
    renderHistory();
    showToast('Rota removida');
  }

  /* ---------------------------------------------------------
     10. MODAL: NOVA ROTA
  --------------------------------------------------------- */

  function openModal(modalEl, after) {
    modalEl.classList.add('modal-overlay--active');
    if (after) setTimeout(after, 80);
  }
  function closeModal(modalEl) {
    modalEl.classList.remove('modal-overlay--active');
  }

  // Janela de confirmação reutilizável (excluir rota, restaurar backup...).
  // Retorna uma Promise: true se o usuário confirmou, false se cancelou.
  let confirmResolver = null;

  function askConfirm({ title, message, confirmLabel = 'Confirmar', danger = false }) {
    return new Promise((resolve) => {
      els.confirmTitle.textContent = title;
      els.confirmMessage.textContent = message;
      els.btnConfirmOk.textContent = confirmLabel;
      els.btnConfirmOk.classList.toggle('primary-btn--danger', danger);
      confirmResolver = resolve;
      openModal(els.modalConfirm);
    });
  }

  function resolveConfirm(value) {
    closeModal(els.modalConfirm);
    if (confirmResolver) {
      const resolver = confirmResolver;
      confirmResolver = null;
      resolver(value);
    }
  }

  els.btnConfirmOk.addEventListener('click', () => resolveConfirm(true));
  els.btnConfirmCancel.addEventListener('click', () => resolveConfirm(false));
  els.modalConfirm.addEventListener('click', (e) => {
    if (e.target === els.modalConfirm) resolveConfirm(false);
  });

  // Porcentagem do adicional de domingo/feriado da rota que está sendo
  // lançada. Volta para o padrão (20%) toda vez que o modal é aberto, então
  // a mudança feita pelo lápis vale só para aquela rota.
  let routeFeriadoPctAtual = FERIADO_PCT_PADRAO;

  // Dia para o qual a rota está sendo lançada (hoje, ou outro dia quando
  // vem do botão "+" do calendário do Histórico).
  let routeTargetKey = todayKey();

  const fmtPctInt = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  };

  function updateRoutePreview() {
    const km = clampNum(els.routeKm.value, 0);
    const paradas = clampNum(els.routeParadas.value, 0);
    const consumo = clampNum(els.routeConsumo.value, 0);
    const feriado = els.routeFeriado.checked;
    const feriadoPct = routeFeriadoPctAtual;
    const vehicle = state.settings.vehicle;

    els.routeFeriadoLabel.textContent = `Domingo / Feriado (+${fmtPctInt(feriadoPct)}%)`;

    const { valorKm, valorParadas, faturamento, combustivel, retencoes, lucro, precoUsado } =
      calcRoute({ km, paradas, feriado, feriadoPct, vehicle, consumo });
    const { tipo, hasHistorico } = getLastFuelPrice();

    els.prevKmVal.textContent = fmtBRL(valorKm * (feriado ? 1 + feriadoPct / 100 : 1));
    els.prevParadasVal.textContent = fmtBRL(valorParadas);
    els.prevTotalVal.textContent = fmtBRL(faturamento);
    els.prevFuelVal.textContent = fmtBRL(combustivel);
    els.prevFuelInfo.textContent = hasHistorico
      ? `${tipo || 'combustível'} a ${fmtBRL(precoUsado)}/L`
      : `padrão ${fmtBRL(precoUsado)}/L`;
    els.prevTaxasVal.textContent = `- ${fmtBRL(retencoes.total)}`;
    els.prevLucroVal.textContent = fmtBRL(lucro);
  }

  els.routeKm.addEventListener('input', updateRoutePreview);
  els.routeParadas.addEventListener('input', updateRoutePreview);
  els.routeConsumo.addEventListener('input', updateRoutePreview);
  els.routeFeriado.addEventListener('change', updateRoutePreview);

  // Lápis: abre/fecha o campo para digitar a % do adicional deste dia.
  els.btnEditFeriadoPct.addEventListener('click', () => {
    const aberto = els.feriadoPctField.style.display !== 'none';
    if (aberto) {
      els.feriadoPctField.style.display = 'none';
      return;
    }
    els.feriadoPctField.style.display = '';
    els.routeFeriadoPct.value = routeFeriadoPctAtual;
    setTimeout(() => { els.routeFeriadoPct.focus(); els.routeFeriadoPct.select(); }, 50);
  });

  els.routeFeriadoPct.addEventListener('input', () => {
    const raw = els.routeFeriadoPct.value;
    const pct = clampNum(raw, NaN);
    if (raw !== '' && Number.isFinite(pct) && pct >= 0) {
      routeFeriadoPctAtual = pct;
      if (pct > 0) els.routeFeriado.checked = true; // definiu %, então aplica
    }
    updateRoutePreview();
  });

  // Lembra o último consumo digitado, para pré-preencher a próxima rota
  // e o motorista não precisar redigitar todas as vezes.
  let lastConsumoUsado = null;

  // Abre o modal de Nova Rota para um dia específico (hoje por padrão).
  function openRouteModal(dayKey) {
    routeTargetKey = dayKey || todayKey();
    routeFeriadoPctAtual = FERIADO_PCT_PADRAO;
    els.routeKm.value = '';
    els.routeParadas.value = '';
    els.routeConsumo.value = lastConsumoUsado != null ? lastConsumoUsado : '';
    els.routeNome.value = '';
    els.routeIdRota.value = '';
    els.routeFeriado.checked = false;
    els.feriadoPctField.style.display = 'none';
    els.routeFeriadoPct.value = '';

    if (routeTargetKey !== todayKey()) {
      els.routeModalDate.style.display = '';
      els.routeModalDate.textContent = `Lançando rota em ${fmtDateLabel(routeTargetKey)}`;
    } else {
      els.routeModalDate.style.display = 'none';
      els.routeModalDate.textContent = '';
    }

    updateRoutePreview();
    openModal(els.modalRoute, () => els.routeParadas.focus());
  }

  els.btnAddRoute.addEventListener('click', () => openRouteModal(todayKey()));

  els.btnCancelRoute.addEventListener('click', () => closeModal(els.modalRoute));

  els.btnSaveRoute.addEventListener('click', () => {
    const km = clampNum(els.routeKm.value, NaN);
    const paradas = clampNum(els.routeParadas.value, 0);
    const consumo = clampNum(els.routeConsumo.value, NaN);

    if (!Number.isFinite(km) || km <= 0) {
      showToast('Informe o KM da rota');
      els.routeKm.focus();
      return;
    }
    if (!Number.isFinite(consumo) || consumo <= 0) {
      showToast('Informe o consumo do carro');
      els.routeConsumo.focus();
      return;
    }

    const feriado = els.routeFeriado.checked;
    const feriadoPct = routeFeriadoPctAtual;
    const vehicle = state.settings.vehicle;
    const { valorKm, valorParadas, faturamento, combustivel, retencoes, lucro, precoUsado } =
      calcRoute({ km, paradas, feriado, feriadoPct, vehicle, consumo });

    const nomeRota = els.routeNome.value.trim().slice(0, 30);
    const idRota = els.routeIdRota.value.trim().slice(0, 30);

    const key = routeTargetKey || todayKey();
    const day = getDay(key);
    day.routes.push({
      id: uid(),
      nomeRota, idRota,
      km, paradas, feriado, feriadoPct, vehicle, consumo,
      valorKm, valorParadas, faturamento,
      combustivel, retencoes, lucro, precoUsado,
      createdAt: Date.now()
    });
    persistDays();
    lastConsumoUsado = consumo;
    closeModal(els.modalRoute);
    renderHome();
    renderHistory();
    showToast(key === todayKey() ? 'Rota adicionada' : `Rota adicionada em ${fmtDateShort(key)}`);
  });

  /* ---------------------------------------------------------
     11. MODAL: KM INICIAL / KM FINAL
  --------------------------------------------------------- */

  els.btnCancelKmStart.addEventListener('click', () => closeModal(els.modalKmStart));

  els.btnSaveKmStart.addEventListener('click', () => {
    const km = clampNum(els.kmInicialInput.value, NaN);
    if (!Number.isFinite(km) || km < 0) {
      showToast('Informe o KM inicial');
      els.kmInicialInput.focus();
      return;
    }
    const key = todayKey();
    const day = getDay(key);
    day.kmInicial = km;
    persistDays();
    closeModal(els.modalKmStart);
    renderHome();
    showToast('KM inicial registrado');
  });

  // Botão "Encerrar dia (KM final)" foi removido da tela "Hoje".
  if (els.btnFinishDay) {
    els.btnFinishDay.addEventListener('click', () => {
      const key = todayKey();
      const day = getDay(key);

      if (day.kmInicial == null) {
        showToast('Registre o KM inicial primeiro');
        return;
      }

      els.kmEndInfo.textContent = `KM inicial registrado: ${day.kmInicial.toLocaleString('pt-BR')}`;
      els.kmFinalInput.value = day.kmFinal != null ? day.kmFinal : '';
      els.gastosExtraInput.value = day.gastosExtra ? day.gastosExtra : '';
      openModal(els.modalKmEnd, () => els.kmFinalInput.focus());
    });
  }

  els.btnCancelKmEnd.addEventListener('click', () => closeModal(els.modalKmEnd));

  els.btnSaveKmEnd.addEventListener('click', () => {
    const key = todayKey();
    const day = getDay(key);
    const kmFinal = clampNum(els.kmFinalInput.value, NaN);

    if (!Number.isFinite(kmFinal) || kmFinal < day.kmInicial) {
      showToast('KM final deve ser maior que o inicial');
      els.kmFinalInput.focus();
      return;
    }

    day.kmFinal = kmFinal;
    day.gastosExtra = clampNum(els.gastosExtraInput.value, 0);
    day.encerrado = true;
    persistDays();
    closeModal(els.modalKmEnd);
    renderHome();
    showToast('Dia encerrado');
  });

  /* ---------------------------------------------------------
     12. CONFIGURAÇÕES
  --------------------------------------------------------- */

  function fillSettingsForm() {
    els.cfgVehicle.value = state.settings.vehicle;
  }

  els.btnSaveSettings.addEventListener('click', () => {
    state.settings.vehicle = els.cfgVehicle.value;
    persistSettings();
    fillSettingsForm();
    showToast('Configurações salvas');
    goToScreen('home');
  });

  /* ---------------------------------------------------------
     13. ABASTECIMENTOS
  --------------------------------------------------------- */

  function updateFuelPreview() {
    const valor = clampNum(els.fuelValor.value, 0);
    const preco = clampNum(els.fuelPreco.value, 0);
    if (valor > 0 && preco > 0) {
      const litros = valor / preco;
      els.fuelLitrosPreview.textContent = `Litros abastecidos: ${litros.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L`;
    } else {
      els.fuelLitrosPreview.textContent = 'Litros abastecidos: \u2014';
    }
  }
  els.fuelValor.addEventListener('input', updateFuelPreview);
  els.fuelPreco.addEventListener('input', updateFuelPreview);

  els.btnAddFuel.addEventListener('click', () => {
    const tipo = els.fuelType.value;
    const valor = clampNum(els.fuelValor.value, NaN);
    const preco = clampNum(els.fuelPreco.value, NaN);

    if (!Number.isFinite(valor) || valor <= 0 || !Number.isFinite(preco) || preco <= 0) {
      showToast('Preencha valor e preço por litro');
      return;
    }

    const litros = valor / preco;
    state.fuel.push({
      id: uid(),
      tipo, valor, preco, litros,
      date: todayKey(),
      createdAt: Date.now()
    });
    persistFuel();

    // Atualiza preço médio do combustível nas configurações automaticamente,
    // já que é o dado mais recente informado pelo motorista.
    state.settings.precoCombustivel = preco;
    persistSettings();

    els.fuelValor.value = '';
    els.fuelPreco.value = '';
    updateFuelPreview();
    renderFuelList();
    renderHome();
    showToast('Abastecimento registrado');
  });

  function renderFuelList() {
    els.fuelList.innerHTML = '';
    if (state.fuel.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhum abastecimento registrado ainda.';
      els.fuelList.appendChild(empty);
      return;
    }

    state.fuel.slice().reverse().forEach((f) => {
      const item = document.createElement('div');
      item.className = 'fuel-item';
      item.innerHTML = `
        <div>
          <p class="fuel-item__type">${f.tipo}</p>
          <p class="fuel-item__meta">${fmtDateShort(f.date)} \u00B7 ${f.litros.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L a ${fmtBRL(f.preco)}/L</p>
        </div>
        <span class="fuel-item__value">${fmtBRL(f.valor)}</span>
      `;
      els.fuelList.appendChild(item);
    });
  }

  /* ---------------------------------------------------------
     14. HISTÓRICO
  --------------------------------------------------------- */

  let historyRange = 'quinzena';

  els.historySegmented.querySelectorAll('.segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      historyRange = btn.dataset.range;
      els.historySegmented.querySelectorAll('.segmented__btn').forEach(b =>
        b.classList.toggle('segmented__btn--active', b === btn)
      );
      renderHistory();
    });
  });

  function renderHistory() {
    els.historyBody.innerHTML = '';
    if (historyRange === 'quinzena') {
      renderHistoryQuinzenas();
    } else {
      renderHistoryDays();
    }
  }

  function renderHistoryQuinzenas() {
    // Mostra a quinzena atual + outras quinzenas com movimento registrado.
    const allDayKeys = Object.keys(state.days).sort();
    if (allDayKeys.length === 0) {
      els.historyBody.innerHTML = '<p class="empty-state">Nenhum dado registrado ainda.</p>';
      return;
    }

    const cards = [];
    const seen = new Set();
    const refDates = [new Date(), ...allDayKeys.map(parseKey)].sort((a, b) => b - a);

    for (const ref of refDates) {
      const q = calcQuinzenaTotals(ref);
      const sig = q.start.getTime();
      if (seen.has(sig)) continue;
      seen.add(sig);
      cards.push(q);
      if (cards.length >= 6) break;
    }

    const hojeInicio = new Date();
    hojeInicio.setHours(0, 0, 0, 0);

    cards.forEach((q, idx) => {
      const card = document.createElement('div');
      const pay = getQuinzenaPayStatus(q);
      card.className = `period-card period-card--${pay.status}`;
      const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const isAtual = q.start <= hojeInicio && hojeInicio <= q.end;
      card.innerHTML = `
        <div class="period-card__top">
          <div>
            <p class="period-card__title">${startLabel} \u2014 ${endLabel}</p>
            <p class="period-card__value" style="${q.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(q.lucro)}</p>
          </div>
          <div class="period-card__top-right">
            <button class="pct-btn" type="button" data-quinzena-list="${idx}" aria-label="Ver todas as rotas da quinzena">\ud83d\uddd2\ufe0f</button>
            <button class="pct-btn" type="button" data-quinzena-idx="${idx}" aria-label="Ver detalhamento dos descontos">%</button>
            <span class="period-card__badge">${isAtual ? 'Atual' : `${q.diasComMovimento} dia(s)`}</span>
          </div>
        </div>
        <div class="period-card__grid">
          <div><span>Faturamento</span><b>${fmtBRL(q.faturamento)}</b></div>
          <div><span>Abastecido</span><b>${fmtBRL(q.combustivel)}</b></div>
          <div><span>Rotas</span><b>${q.rotas}</b></div>
        </div>
      `;
      els.historyBody.appendChild(card);
    });

    els.historyBody.querySelectorAll('[data-quinzena-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.quinzenaIdx, 10);
        openQuinzenaDetailModal(cards[idx]);
      });
    });

    els.historyBody.querySelectorAll('[data-quinzena-list]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.quinzenaList, 10);
        openQuinzenaRoutesModal(cards[idx]);
      });
    });
  }

  // Data em que cada quinzena \u00e9 paga: a 1\u00aa (dia 01 a 15) cai no dia 07 do
  // m\u00eas seguinte; a 2\u00aa (dia 16 ao fim do m\u00eas) cai no dia 22 do m\u00eas seguinte.
  function getQuinzenaPayDate(q) {
    const ano = q.start.getFullYear();
    const mes = q.start.getMonth();
    const dia = q.start.getDate() <= 15 ? 7 : 22;
    return new Date(ano, mes + 1, dia);
  }

  // Pr\u00f3xima data de pagamento a partir de hoje (independe de ter rota
  // lan\u00e7ada naquela quinzena). No pr\u00f3prio dia do pagamento j\u00e1 conta como
  // recebida.
  function getNextPayDate(hoje) {
    let melhor = null;
    for (let deslocamento = -3; deslocamento <= 1; deslocamento++) {
      [1, 16].forEach((dia) => {
        const inicio = new Date(hoje.getFullYear(), hoje.getMonth() + deslocamento, dia);
        const pay = getQuinzenaPayDate({ start: inicio });
        if (pay > hoje && (!melhor || pay < melhor)) melhor = pay;
      });
    }
    return melhor;
  }

  // 'paga' (verde) | 'proxima' (roxo) | 'futura' (cinza)
  function getQuinzenaPayStatus(q) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const pay = getQuinzenaPayDate(q);
    if (pay <= hoje) return { status: 'paga', pay };
    const proxima = getNextPayDate(hoje);
    const ehProxima = proxima && pay.getTime() === proxima.getTime();
    return { status: ehProxima ? 'proxima' : 'futura', pay };
  }

  // Lista todas as rotas de uma quinzena (bot\u00e3o \ud83d\uddd2\ufe0f do card).
  function openQuinzenaRoutesModal(q) {
    const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    els.qrPeriodLabel.textContent = `${startLabel} a ${endLabel}`;
    els.qrList.innerHTML = '';

    let totalRotas = 0;
    let totalKm = 0;
    const cursor = new Date(q.end);
    while (cursor >= q.start) {
      const key = todayKey(cursor);
      const day = state.days[key];
      const rotas = day ? day.routes.map(normalizeRoute) : [];
      if (rotas.length > 0) {
        const titulo = document.createElement('p');
        titulo.className = 'qr-day';
        titulo.textContent = fmtDateLabel(key);
        els.qrList.appendChild(titulo);

        rotas.forEach((r, i) => {
          totalRotas++;
          totalKm += clampNum(r.km, 0);
          const item = document.createElement('div');
          item.className = 'qr-item';
          item.innerHTML = `
            <div>
              ${routeChipsHtml(r)}
              <p class="qr-item__main">Rota ${i + 1} \u00b7 ${fmtKM(r.km)}</p>
              <p class="qr-item__meta">Faturamento ${fmtBRL(r.faturamento)}</p>
            </div>
            <span class="qr-item__value" style="${r.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(r.lucro)}</span>
          `;
          els.qrList.appendChild(item);
        });
      }
      cursor.setDate(cursor.getDate() - 1);
    }

    if (totalRotas === 0) {
      els.qrList.innerHTML = '<p class="empty-state">Nenhuma rota nessa quinzena.</p>';
    } else {
      const total = document.createElement('div');
      total.className = 'qr-total';
      total.innerHTML = `<span>${totalRotas} rota${totalRotas === 1 ? '' : 's'}</span><span>${fmtKM(totalKm)}</span>`;
      els.qrList.appendChild(total);
    }

    openModal(els.modalQuinzenaRoutes);
  }

  els.btnCloseQuinzenaRoutes.addEventListener('click', () => closeModal(els.modalQuinzenaRoutes));

  /* ---------------------------------------------------------
     14b. BACKUP (baixar / restaurar)
     Serve para levar os dados de uma versão do app para outra.
  --------------------------------------------------------- */

  const BACKUP_APP_ID = 'balancimetro';
  const BACKUP_VERSION = 1;

  els.btnOpenBackup.addEventListener('click', () => openModal(els.modalBackup));
  els.btnBackupCancel.addEventListener('click', () => closeModal(els.modalBackup));
  els.modalBackup.addEventListener('click', (e) => {
    if (e.target === els.modalBackup) closeModal(els.modalBackup);
  });

  els.btnBackupDownload.addEventListener('click', () => {
    const payload = {
      app: BACKUP_APP_ID,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      data: { settings: state.settings, days: state.days, fuel: state.fuel }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `balancimetro-backup-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeModal(els.modalBackup);
    showToast('Backup baixado');
  });

  els.btnBackupUpload.addEventListener('click', () => {
    els.backupFile.value = '';
    els.backupFile.click();
  });

  // Confere o arquivo e devolve os dados já limpos, ou null se não for um
  // backup válido do Balancímetro.
  function parseBackup(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    if (!json || json.app !== BACKUP_APP_ID || !json.data) return null;

    const { settings, days, fuel } = json.data;
    if (!days || typeof days !== 'object' || Array.isArray(days)) return null;
    if (!Array.isArray(fuel)) return null;

    const cleanDays = {};
    Object.keys(days).forEach((key) => {
      const d = days[key];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      if (!d || typeof d !== 'object' || !Array.isArray(d.routes)) return;
      cleanDays[key] = { ...d, routes: d.routes.filter(r => r && typeof r === 'object') };
    });

    const cleanFuel = fuel.filter(f =>
      f && typeof f === 'object' && typeof f.date === 'string' && Number.isFinite(f.valor)
    );

    const cleanSettings = { ...defaultSettings(), ...(settings && typeof settings === 'object' ? settings : {}) };
    if (!VEHICLE_LABELS[cleanSettings.vehicle]) cleanSettings.vehicle = defaultSettings().vehicle;

    return { settings: cleanSettings, days: cleanDays, fuel: cleanFuel };
  }

  els.backupFile.addEventListener('change', async () => {
    const file = els.backupFile.files && els.backupFile.files[0];
    if (!file) return;

    let text;
    try {
      text = await file.text();
    } catch (e) {
      showToast('Não consegui ler o arquivo');
      return;
    }

    const backup = parseBackup(text);
    if (!backup) {
      showToast('Arquivo inválido: não é um backup do Balancímetro');
      return;
    }

    const totalDias = Object.keys(backup.days).length;
    const totalRotas = Object.values(backup.days).reduce((acc, d) => acc + d.routes.length, 0);
    const ok = await askConfirm({
      title: 'Restaurar backup?',
      message: `O backup tem ${totalDias} dia(s), ${totalRotas} rota(s) e ${backup.fuel.length} abastecimento(s). Os dados atuais deste aparelho serão substituídos por eles.`,
      confirmLabel: 'Restaurar',
      danger: true
    });
    if (!ok) return;

    state.settings = backup.settings;
    state.days = backup.days;
    state.fuel = backup.fuel;
    persistSettings();
    persistDays();
    persistFuel();

    closeModal(els.modalBackup);
    fillSettingsForm();
    renderFuelList();
    renderHome();
    renderHistory();
    showToast('Backup restaurado');
  });

  // Preenche e abre o modal de extrato/detalhamento de descontos da quinzena.
  function openQuinzenaDetailModal(q) {
    const bruto = q.faturamento;
    const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    els.qdPeriodLabel.textContent = `${startLabel} a ${endLabel}`;

    const combustivelPct = bruto > 0 ? (q.combustivel / bruto) * 100 : 0;
    const totalDescontos = q.combustivel + q.retencoes.total + q.gastosExtra;
    const descontosPct = bruto > 0 ? (totalDescontos / bruto) * 100 : 0;
    const liquidoPct = bruto > 0 ? (q.lucro / bruto) * 100 : 0;

    els.qdBrutoVal.textContent = fmtBRL(bruto);
    els.qdFuelVal.textContent = `- ${fmtBRL(q.combustivel)}`;
    els.qdFuelPct.textContent = fmtPct(combustivelPct);
    els.qdRateioVal.textContent = `- ${fmtBRL(q.retencoes.rateioAdm)}`;
    els.qdInssVal.textContent = `- ${fmtBRL(q.retencoes.inss)}`;
    els.qdSestVal.textContent = `- ${fmtBRL(q.retencoes.sestSenat)}`;

    if (q.gastosExtra > 0) {
      els.qdExtraRow.style.display = '';
      els.qdExtraVal.textContent = `- ${fmtBRL(q.gastosExtra)}`;
    } else {
      els.qdExtraRow.style.display = 'none';
    }

    els.qdDescontosVal.textContent = `- ${fmtBRL(totalDescontos)}`;
    els.qdDescontosPct.textContent = fmtPct(descontosPct);
    els.qdLiquidoVal.textContent = fmtBRL(q.lucro);
    els.qdLiquidoVal.style.color = q.lucro < 0 ? 'var(--danger)' : '';
    els.qdLiquidoPct.textContent = fmtPct(liquidoPct);

    openModal(els.modalQuinzenaDetail);
  }

  els.btnCloseQuinzenaDetail.addEventListener('click', () => closeModal(els.modalQuinzenaDetail));

  // Estado do calendário do histórico "Por dia": mês exibido e dia selecionado.
  let calendarViewDate = new Date();
  let calendarSelectedKey = todayKey();

  function renderHistoryDays() {
    els.historyBody.innerHTML = '';

    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    const monthLabel = calendarViewDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    // Faixa da quinzena ATUAL (para circular os dias que fazem parte dela).
    const quinzena = getQuinzenaRange(new Date());
    const qStart = new Date(quinzena.start.getFullYear(), quinzena.start.getMonth(), quinzena.start.getDate()).getTime();
    const qEnd = new Date(quinzena.end.getFullYear(), quinzena.end.getMonth(), quinzena.end.getDate()).getTime();

    const firstOfMonth = new Date(year, month, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

    const cellsHtml = [];
    for (let i = 0; i < totalCells; i++) {
      const dayOffset = i - startWeekday + 1;
      let cellDate;
      let muted = false;
      if (dayOffset < 1) {
        cellDate = new Date(year, month - 1, daysInPrevMonth + dayOffset);
        muted = true;
      } else if (dayOffset > daysInMonth) {
        cellDate = new Date(year, month + 1, dayOffset - daysInMonth);
        muted = true;
      } else {
        cellDate = new Date(year, month, dayOffset);
      }

      const key = todayKey(cellDate);
      const t = calcDayTotals(key);
      const worked = t.rotas > 0 || t.kmRodado > 0;
      const cellTime = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate()).getTime();
      const inQuinzena = cellTime >= qStart && cellTime <= qEnd;
      const selected = key === calendarSelectedKey;

      const classes = ['calendar-day'];
      if (muted) classes.push('calendar-day--muted');
      if (inQuinzena) classes.push('calendar-day--quinzena');
      if (worked) classes.push('calendar-day--worked');
      if (selected) classes.push('calendar-day--selected');

      cellsHtml.push(`<div class="${classes.join(' ')}" data-key="${key}"><span class="calendar-day__num">${cellDate.getDate()}</span></div>`);
    }

    const card = document.createElement('div');
    card.className = 'calendar-card';
    card.innerHTML = `
      <div class="calendar-card__head">
        <button class="calendar-nav" type="button" data-cal-nav="-1" aria-label="Mês anterior">\u2039</button>
        <span class="calendar-title">${monthLabel}</span>
        <button class="calendar-nav" type="button" data-cal-nav="1" aria-label="Próximo mês">\u203A</button>
      </div>
      <div class="calendar-weekdays">
        <span>D</span><span>S</span><span>T</span><span>Q</span><span>Q</span><span>S</span><span>S</span>
      </div>
      <div class="calendar-grid">${cellsHtml.join('')}</div>
      <div class="calendar-legend">
        <span><span class="calendar-legend__dot calendar-legend__dot--worked"></span>Dia trabalhado</span>
        <span><span class="calendar-legend__dot calendar-legend__dot--quinzena"></span>Dentro da quinzena</span>
      </div>
    `;
    els.historyBody.appendChild(card);

    card.querySelectorAll('[data-cal-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir = parseInt(btn.dataset.calNav, 10);
        calendarViewDate = new Date(year, month + dir, 1);
        renderHistoryDays();
      });
    });

    card.querySelectorAll('.calendar-day').forEach(cell => {
      cell.addEventListener('click', () => {
        calendarSelectedKey = cell.dataset.key;
        renderHistoryDays();
      });
    });

    renderCalendarSelectedRoutes(calendarSelectedKey);
  }

  function renderCalendarSelectedRoutes(key) {
    const day = state.days[key];
    const routes = day ? day.routes.map(normalizeRoute) : [];

    const head = document.createElement('div');
    head.className = 'calendar-selected-head';
    head.innerHTML = `
      <p class="calendar-selected-label">${fmtDateLabel(key)} \u2014 ${routes.length} rota${routes.length === 1 ? '' : 's'}</p>
      <button class="add-route-btn" type="button" aria-label="Adicionar rota neste dia">+</button>
    `;
    els.historyBody.appendChild(head);
    head.querySelector('.add-route-btn').addEventListener('click', () => openRouteModal(key));

    if (routes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhuma rota registrada nesse dia. Toque no + para lan\u00e7ar uma.';
      els.historyBody.appendChild(empty);
      return;
    }

    routes.forEach((r, idx) => {
      const tag = document.createElement('div');
      tag.className = 'route-tag';
      tag.innerHTML = `
        <div class="route-tag__top">
          <p class="route-tag__title">Rota ${idx + 1}</p>
          <button class="route-tag__del" type="button" aria-label="Excluir rota">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        ${routeChipsHtml(r)}
        <div class="route-tag__grid">
          <div><span>KM</span><b>${fmtKM(r.km)}</b></div>
          <div><span>Faturamento</span><b>${fmtBRL(r.faturamento)}</b></div>
          <div><span>Lucro</span><b class="profit" style="${r.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(r.lucro)}</b></div>
        </div>
      `;
      els.historyBody.appendChild(tag);
      tag.querySelector('.route-tag__del').addEventListener('click', () => deleteRouteWithConfirm(key, r));
    });
  }

  // Exclui uma rota de um dia qualquer (usado pelo calend\u00e1rio do Hist\u00f3rico),
  // sempre pedindo confirma\u00e7\u00e3o antes.
  async function deleteRouteWithConfirm(key, route) {
    const ok = await askConfirm({
      title: 'Excluir rota?',
      message: `${fmtDateLabel(key)} \u00b7 ${fmtKM(route.km)} \u00b7 lucro ${fmtBRL(route.lucro)}. Essa a\u00e7\u00e3o n\u00e3o pode ser desfeita.`,
      confirmLabel: 'Excluir',
      danger: true
    });
    if (!ok) return;

    const day = state.days[key];
    if (!day) return;
    day.routes = day.routes.filter(r => r.id !== route.id);

    // Dia que ficou totalmente vazio sai do registro, pra n\u00e3o gerar
    // quinzena/dia "fantasma" no hist\u00f3rico.
    const vazio = day.routes.length === 0 && day.kmInicial == null && day.kmFinal == null && !clampNum(day.gastosExtra, 0);
    if (vazio) delete state.days[key];

    persistDays();
    renderHome();
    renderHistory();
    showToast('Rota exclu\u00edda');
  }

  /* ---------------------------------------------------------
     15. GRÁFICOS (Canvas nativo, sem dependências externas
     para manter o app 100% funcional offline)
  --------------------------------------------------------- */

  let chartsPeriod = 'dia';

  els.chartsSegmented.querySelectorAll('.segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartsPeriod = btn.dataset.period;
      els.chartsSegmented.querySelectorAll('.segmented__btn').forEach(b =>
        b.classList.toggle('segmented__btn--active', b === btn)
      );
      renderCharts();
    });
  });

  // Resolução do canvas em pixels reais (devicePixelRatio) para texto nítido.
  function setupCanvasDPR(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.parentElement.clientWidth - 20; // padding interno do card
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function drawLineSeries(ctx, points, valueKey, color, bounds, plot) {
    const { minY, maxY } = bounds;
    const range = (maxY - minY) || 1;
    const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = plot.x + stepX * i;
      const norm = (p[valueKey] - minY) / range;
      const y = plot.y + plot.h - norm * plot.h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Pontos
    points.forEach((p, i) => {
      const x = plot.x + stepX * i;
      const norm = (p[valueKey] - minY) / range;
      const y = plot.y + plot.h - norm * plot.h;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  // Guarda a última geometria de plotagem, usada para mapear cliques do
  // usuário (posição X em pixels) para o índice do ponto correspondente.
  let chartsPlotGeometry = null;
  let chartsLastPoints = [];
  let chartsHighlightIndex = null;

  function renderChartCanvas(points, highlightIndex) {
    const canvas = els.chartCanvas;
    const cardBody = canvas.parentElement;

    if (!points.length) {
      cardBody.innerHTML = '<p class="chart-empty">Sem dados suficientes ainda. Registre rotas e KM para ver o gráfico aqui.</p>';
      chartsPlotGeometry = null;
      return;
    }

    const { ctx, width, height } = setupCanvasDPR(canvas, 240);
    ctx.clearRect(0, 0, width, height);

    const plot = { x: 8, y: 14, w: width - 16, h: height - 46 };
    const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;
    chartsPlotGeometry = { plot, stepX, count: points.length };

    // Cada série é normalizada na MESMA área de plotagem, mas com seus
    // próprios min/max — isso permite comparar tendências (sobe/desce)
    // mesmo com magnitudes bem diferentes (KM em dezenas/centenas,
    // R$ lucro e combustível em outra escala).
    // KM é desenhado por último (por cima) com uma cor de alto contraste,
    // já que tende a ficar "escondido" atrás das outras duas linhas.
    const seriesDefs = [
      { key: 'lucro', color: getCSS('--accent') },
      { key: 'combustivel', color: getCSS('--accent-2') },
      { key: 'km', color: '#7FD4FF' }
    ];

    seriesDefs.forEach(({ key, color }) => {
      const values = points.map(p => p[key]);
      let minY = Math.min(...values, 0);
      let maxY = Math.max(...values, 0);
      if (minY === maxY) { minY -= 1; maxY += 1; }
      // Margem de 8% para as linhas não colarem nas bordas.
      const pad = (maxY - minY) * 0.08;
      drawLineSeries(ctx, points, key, color, { minY: minY - pad, maxY: maxY + pad }, plot);
    });

    // Marcador vertical do ponto selecionado (se houver), desenhado por
    // cima das linhas para indicar qual dia/semana/mês está em destaque.
    if (highlightIndex != null && highlightIndex >= 0 && highlightIndex < points.length) {
      const x = plot.x + stepX * highlightIndex;
      ctx.strokeStyle = getCSS('--text');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Linha de base (eixo X)
    ctx.strokeStyle = getCSS('--line');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y + plot.h + 0.5);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5);
    ctx.stroke();

    // Rótulos do eixo X: escolhe um espaçamento que garanta não haver
    // sobreposição entre rótulos consecutivos (inclusive o último).
    ctx.fillStyle = getCSS('--text-dim');
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    const minLabelGapPx = 46; // espaço mínimo entre o centro de dois rótulos
    const labelStep = Math.max(1, Math.ceil(minLabelGapPx / Math.max(stepX, 1)));

    let lastLabelX = -Infinity;
    points.forEach((p, i) => {
      const isLast = i === points.length - 1;
      const onStep = i % labelStep === 0;
      if (!onStep && !isLast) return;
      const x = plot.x + stepX * i;
      // Evita desenhar o último rótulo se ele ficar colado no anterior.
      if (x - lastLabelX < minLabelGapPx * 0.6) return;
      ctx.fillText(p.label, x, plot.y + plot.h + 18);
      lastLabelX = x;
    });
  }

  // Toque/clique no canvas: identifica o ponto mais próximo do X tocado
  // e sincroniza o destaque com a lista detalhada abaixo.
  function handleChartTap(clientX) {
    if (!chartsPlotGeometry || !chartsLastPoints.length) return;
    const canvas = els.chartCanvas;
    const rect = canvas.getBoundingClientRect();
    const xInCanvas = clientX - rect.left;
    const { plot, stepX, count } = chartsPlotGeometry;

    let idx = stepX > 0 ? Math.round((xInCanvas - plot.x) / stepX) : 0;
    idx = Math.max(0, Math.min(count - 1, idx));

    chartsHighlightIndex = chartsHighlightIndex === idx ? null : idx;
    renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
    renderChartsDetailList(chartsLastPoints, chartsHighlightIndex);

    if (chartsHighlightIndex != null) {
      const card = document.querySelector(`.chart-detail-card[data-idx="${chartsHighlightIndex}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  els.chartCanvas.addEventListener('click', (e) => handleChartTap(e.clientX));

  function getCSS(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function renderChartsSummary(points) {
    if (!points.length) {
      els.chartsSummary.innerHTML = '';
      return;
    }
    const totalKm = points.reduce((a, p) => a + p.km, 0);
    const totalLucro = points.reduce((a, p) => a + p.lucro, 0);
    const totalCombustivel = points.reduce((a, p) => a + p.combustivel, 0);

    els.chartsSummary.innerHTML = `
      <div class="chart-summary__card">
        <p class="chart-summary__label">Lucro no período</p>
        <p class="chart-summary__value" style="color:${totalLucro < 0 ? 'var(--danger)' : 'var(--accent)'}">${fmtBRL(totalLucro)}</p>
      </div>
      <div class="chart-summary__card">
        <p class="chart-summary__label">KM total</p>
        <p class="chart-summary__value">${fmtKM(totalKm)}</p>
      </div>
      <div class="chart-summary__card">
        <p class="chart-summary__label">Combustível</p>
        <p class="chart-summary__value" style="color:var(--accent-2)">${fmtBRL(totalCombustivel)}</p>
      </div>
    `;
  }

  const CHARTS_LIST_TITLES = {
    dia: 'Detalhe por dia',
    semana: 'Detalhe por semana',
    mes: 'Detalhe por mês'
  };

  // Renderiza a lista detalhada (mais recente primeiro), com Lucro,
  // Faturamento bruto, Combustível e KM de cada dia/semana/mês.
  function renderChartsDetailList(points, highlightIndex) {
    const titleEl = document.getElementById('charts-list-title');
    if (titleEl) titleEl.textContent = CHARTS_LIST_TITLES[chartsPeriod] || 'Detalhe';

    const container = document.getElementById('charts-detail-list');
    if (!points.length) {
      container.innerHTML = '<p class="empty-state">Sem dados suficientes ainda.</p>';
      return;
    }

    const ordered = points.map((p, idx) => ({ ...p, idx })).slice().reverse();

    container.innerHTML = ordered.map((p) => `
      <div class="chart-detail-card${p.idx === highlightIndex ? ' chart-detail-card--highlight' : ''}" data-idx="${p.idx}">
        <div class="chart-detail-card__top">
          <span class="chart-detail-card__date">${p.fullLabel}</span>
          <span class="chart-detail-card__lucro" style="color:${p.lucro < 0 ? 'var(--danger)' : 'var(--accent)'}">${fmtBRL(p.lucro)}</span>
        </div>
        <div class="chart-detail-card__grid">
          <div><span>Faturamento</span><b>${fmtBRL(p.faturamento)}</b></div>
          <div><span>Combustível</span><b>${fmtBRL(p.combustivel)}</b></div>
          <div><span>KM</span><b>${fmtKM(p.km)}</b></div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.chart-detail-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        chartsHighlightIndex = chartsHighlightIndex === idx ? null : idx;
        renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
        renderChartsDetailList(chartsLastPoints, chartsHighlightIndex);
      });
    });
  }

  function renderCharts() {
    chartsHighlightIndex = null;
    const points = buildChartSeries(chartsPeriod);
    chartsLastPoints = points;
    renderChartCanvas(points, null);
    renderChartsSummary(points);
    renderChartsDetailList(points, null);
  }

  // Redesenha o gráfico ao girar/redimensionar a tela, para o canvas
  // acompanhar a largura correta.
  window.addEventListener('resize', () => {
    const chartsScreen = document.querySelector('#screen-charts');
    if (chartsScreen && chartsScreen.classList.contains('screen--active')) {
      renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
    }
  });

  /* ---------------------------------------------------------
     16. SPLASH SCREEN
     Mostra a tela de abertura por um tempo mínimo (para não
     "piscar" em devices rápidos) e some assim que o app
     estiver pronto.
  --------------------------------------------------------- */

  const SPLASH_MIN_MS = 1400;

  function hideSplash() {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('splash--hidden');
    setTimeout(() => splash.remove(), 550);
  }

  function setupSplash() {
    const start = Date.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const elapsed = Date.now() - start;
      const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
      setTimeout(hideSplash, wait);
    };

    if (document.readyState === 'complete') {
      finish();
    } else {
      window.addEventListener('load', finish);
    }
    // Garantia: nunca deixa a splash presa, mesmo que 'load' nunca
    // dispare (ex: imagem de fundo ausente ou rede lenta).
    setTimeout(finish, 2000);
  }

  /* ---------------------------------------------------------
     17. INICIALIZAÇÃO
  --------------------------------------------------------- */

  function init() {
    setupSplash();

    // Garante que o dia de hoje exista no armazenamento para consistência.
    ensureDayExists(todayKey());
    fillSettingsForm();
    updateFuelPreview();
    renderHome();

    // Fecha modais ao clicar fora do sheet.
    [els.modalRoute, els.modalKmStart, els.modalKmEnd, els.modalQuinzenaDetail, els.modalQuinzenaRoutes].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });

    // Registra o service worker para funcionamento offline.
    // Usa um caminho relativo ao documento atual (funciona tanto na raiz
    // quanto em subpastas, como no GitHub Pages: usuario.github.io/repo/).
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        const swUrl = new URL('service-worker.js', document.baseURI).href;
        const swScope = new URL('./', document.baseURI).href;
        navigator.serviceWorker.register(swUrl, { scope: swScope })
          .then((reg) => {
            console.log('Service worker registrado com sucesso:', reg.scope);
          })
          .catch((err) => {
            console.warn('Falha ao registrar service worker', err);
          });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
