// src/schedule.js
// Cronograma real del ramal Once-Moreno, tomado de la misma fuente que usa
// trensarmientoenlinea.com.ar (array "S" en index.html), para que el bot dé
// horarios exactos y no solo frecuencias aproximadas.
//
// IMPORTANTE: si actualizás el cronograma en el sitio (index.html, variables
// STATIONS/PRECIOS/OFFSET/S), copiá el mismo cambio acá para que no se
// desincronicen. Última sincronización: 2026-09-09.

export const STATIONS = [
  { id: 0, name: "Once", km: 0, sec: 1, direccion: "Av. Pueyrredón y B. Mitre, Balvanera, CABA", colectivos: ["5","7","12","19","24","26","29","32","37","41","56","57","61","62","64","68","71","75","86","88","95","98","99","101","104","105","106","109","115","118","124","132","140","146","151","165","168","188"], subte: ["Línea A (Plaza Miserere)", "Línea H (Once)"], conexiones: [], nota: "Terminal principal del Tren Sarmiento." },
  { id: 1, name: "Caballito", km: 4, sec: 1, direccion: "Rojas s/n, Caballito, CABA", colectivos: ["2","6","25","26","36","55","63","68","71","86","92","96","106","135","149","163","168","178","180"], subte: ["Línea A (Primera Junta, Carabobo)", "Línea E (Medrano)"], conexiones: [], nota: "" },
  { id: 2, name: "Flores", km: 7, sec: 1, direccion: "Av. Rivadavia 6200, Flores, CABA", colectivos: ["2","25","36","55","86","92","96","116","135","141","149","157","163","180","188"], subte: ["Línea A (Flores, Carabobo)"], conexiones: [], nota: "" },
  { id: 3, name: "Floresta", km: 9, sec: 1, direccion: "Habana esq. Olivera, Floresta, CABA", colectivos: ["55","96","116","135","141","157","163","180","188"], subte: [], conexiones: [], nota: "" },
  { id: 4, name: "Villa Luro", km: 11, sec: 1, direccion: "Av. Luro esq. Ramón L. Falcón, Villa Luro, CABA", colectivos: ["55","96","100","116","135","141","157","163","180","188"], subte: [], conexiones: [], nota: "" },
  { id: 5, name: "Liniers", km: 13, sec: 2, direccion: "Av. Rivadavia 11900, Liniers, CABA", colectivos: ["96","97","99","100","103","107","116","126","128","136","141","180","188"], subte: [], conexiones: [], nota: "Importante nodo de transporte del oeste porteño." },
  { id: 6, name: "Ciudadela", km: 16, sec: 2, direccion: "Av. Rivadavia, Ciudadela, La Matanza", colectivos: ["99","100","103","117","126","136","141","164","180","188","237"], subte: [], conexiones: [], nota: "" },
  { id: 7, name: "Ramos Mejía", km: 19, sec: 2, direccion: "Av. Rivadavia s/n, Ramos Mejía, La Matanza", colectivos: ["1","88","96","100","136","153","163","172","182","205","237","238","242","247","264"], subte: [], conexiones: [], nota: "" },
  { id: 8, name: "Haedo", km: 22, sec: 2, direccion: "Av. Rivadavia s/n, Haedo, Morón", colectivos: ["103","136","141","164","180","238","247","264","308"], subte: [], conexiones: ["Línea Roca ramal Haedo–Temperley"], nota: "Combinación con Línea Roca hacia el sur del conurbano." },
  { id: 9, name: "Morón", km: 28, sec: 3, direccion: "Av. Victorino de la Plaza s/n, Morón", colectivos: ["141","164","180","183","236","237","238","242","247","257","264","308","325"], subte: [], conexiones: [], nota: "⚠️ Andén provisorio hacia Once. Acceso por Sarmiento y Azcuénaga." },
  { id: 10, name: "Castelar", km: 32, sec: 3, direccion: "Av. Rivadavia s/n, Castelar, Morón", colectivos: ["141","164","180","236","238","264","308","325"], subte: [], conexiones: [], nota: "" },
  { id: 11, name: "Ituzaingó", km: 35, sec: 3, direccion: "Gaona s/n, Ituzaingó", colectivos: ["141","164","180","236","238","264","308","325","441"], subte: [], conexiones: [], nota: "" },
  { id: 12, name: "San Antonio de Padua", km: 39, sec: 3, aliases: ["San A. de Padua", "San Antonio"], direccion: "Dr. Horacio Varela s/n, San Antonio de Padua, Merlo", colectivos: ["180","236","264","308","350","441","455"], subte: [], conexiones: [], nota: "" },
  { id: 13, name: "Merlo", km: 42, sec: 3, direccion: "Av. Libertad s/n, Merlo", colectivos: ["180","236","240","264","281","282","283","284","350","408","440","441","455"], subte: [], conexiones: ["Ramal Merlo–Lobos (diésel)"], nota: "Cabecera del ramal diésel hacia Lobos." },
  { id: 14, name: "Paso del Rey", km: 46, sec: 3, direccion: "Av. San Martín s/n, Paso del Rey, Moreno", colectivos: ["180","236","440","441","500"], subte: [], conexiones: [], nota: "" },
  { id: 15, name: "Moreno", km: 52, sec: 3, direccion: "Av. Libertad 1000, Moreno", colectivos: ["180","267","440","500","501","502"], subte: [], conexiones: ["Ramal Moreno–Mercedes (diésel)"], nota: "Terminal oeste del ramal eléctrico. Conexión con ramal diésel a Mercedes." },
];

// Devuelve un resumen legible de colectivos/subte/conexiones de una estación.
export function infoTransporteEstacion(nombreEstacion) {
  const est = buscarEstacion(nombreEstacion);
  if (!est) return null;
  const partes = [`Dirección: ${est.direccion}.`];
  if (est.colectivos?.length) partes.push(`Colectivos en la zona: ${est.colectivos.join(", ")}.`);
  if (est.subte?.length) partes.push(`Subte: ${est.subte.join(", ")}.`);
  if (est.conexiones?.length) partes.push(`Conexiones: ${est.conexiones.join(", ")}.`);
  if (est.nota) partes.push(est.nota);
  return partes.join(" ");
}

// Tarifas vigentes desde septiembre 2026 (Resolución 27/2026). El sitio web
// todavía tiene los valores anteriores ($310/$420/$520) — al actualizarlos ahí,
// sincronizar también acá.
export const PRECIOS = { 1: 450, 2: 640, 3: 790 };
export const PRECIO_SOCIAL = { 1: 202.5, 2: 288, 3: 355.5 };
export const OFFSET = [0, 8, 13, 17, 21, 25, 30, 35, 40, 46, 52, 56, 61, 65, 68, 71];

const S = {
  lv: {
    once: [[4,5],[4,35],[5,2],[5,22],[5,38],[5,48],[5,58],[6,8],[6,18],[6,28],[6,38],[6,48],[6,58],[7,6],[7,14],[7,22],[7,30],[7,38],[7,46],[7,54],[8,2],[8,10],[8,18],[8,26],[8,34],[8,44],[8,54],[9,4],[9,16],[9,28],[9,42],[9,56],[10,12],[10,28],[10,44],[11,0],[11,18],[11,36],[11,54],[12,12],[12,30],[12,48],[13,6],[13,24],[13,42],[14,0],[14,18],[14,36],[14,54],[15,12],[15,25],[15,30],[15,48],[16,6],[16,11],[16,24],[16,40],[16,52],[16,57],[17,2],[17,12],[17,22],[17,32],[17,42],[17,52],[17,56],[18,2],[18,12],[18,22],[18,32],[18,41],[18,42],[18,52],[19,2],[19,14],[19,26],[19,40],[19,54],[20,8],[20,23],[20,38],[20,54],[21,10],[21,28],[21,46],[22,5],[22,25],[22,47],[23,10],[23,25],[23,55]],
    moreno: [[3,21],[3,44],[4,15],[4,44],[5,1],[5,14],[5,26],[5,28],[5,38],[5,48],[5,58],[6,8],[6,13],[6,18],[6,28],[6,38],[6,48],[6,58],[7,1],[7,8],[7,18],[7,28],[7,38],[7,48],[7,50],[7,58],[8,8],[8,18],[8,28],[8,36],[8,42],[8,56],[9,10],[9,22],[9,24],[9,38],[9,54],[10,10],[10,26],[10,44],[11,2],[11,20],[11,38],[11,56],[12,14],[12,32],[12,50],[13,8],[13,26],[13,44],[14,2],[14,20],[14,38],[14,56],[15,14],[15,32],[15,50],[16,8],[16,26],[16,44],[16,58],[17,8],[17,18],[17,28],[17,38],[17,48],[17,58],[18,8],[18,18],[18,28],[18,38],[18,41],[18,48],[18,58],[19,8],[19,20],[19,28],[19,34],[19,48],[20,2],[20,14],[20,16],[20,31],[20,46],[21,2],[21,19],[21,36],[21,54],[22,12],[22,30]],
  },
  sab: {
    once: [[5,5],[5,35],[6,5],[6,35],[7,5],[7,35],[8,5],[8,25],[8,45],[9,5],[9,25],[9,45],[10,5],[10,25],[10,45],[11,5],[11,25],[11,45],[12,5],[12,25],[12,45],[13,5],[13,25],[13,45],[14,5],[14,25],[14,45],[15,5],[15,25],[15,45],[16,5],[16,25],[16,45],[17,5],[17,25],[17,45],[18,5],[18,25],[18,45],[19,5],[19,25],[19,45],[20,5],[20,30],[20,55],[21,20],[21,50],[22,20],[22,50],[23,20],[23,55]],
    moreno: [[4,5],[4,35],[5,5],[5,35],[6,5],[6,35],[7,5],[7,35],[8,5],[8,35],[9,5],[9,30],[9,55],[10,20],[10,45],[11,10],[11,35],[12,0],[12,25],[12,50],[13,15],[13,40],[14,5],[14,30],[14,55],[15,20],[15,45],[16,10],[16,35],[17,0],[17,25],[17,50],[18,15],[18,40],[19,5],[19,30],[19,55],[20,20],[20,45],[21,10],[21,40],[22,10],[22,40]],
  },
  dom: {
    once: [[6,5],[6,40],[7,15],[7,50],[8,25],[9,0],[9,35],[10,10],[10,45],[11,20],[11,55],[12,30],[13,5],[13,40],[14,15],[14,50],[15,25],[16,0],[16,35],[17,10],[17,45],[18,20],[18,55],[19,30],[20,5],[20,40],[21,15],[21,50],[22,25],[23,0],[23,35]],
    moreno: [[5,10],[5,45],[6,20],[6,55],[7,30],[8,5],[8,40],[9,15],[9,50],[10,25],[11,0],[11,35],[12,10],[12,45],[13,20],[13,55],[14,30],[15,5],[15,40],[16,15],[16,50],[17,25],[18,0],[18,35],[19,10],[19,45],[20,20],[20,55],[21,30],[22,5],[22,40]],
  },
};

const toMins = (h, m) => h * 60 + m;
const pad2 = (n) => String(n).padStart(2, "0");
const fmt = ([h, m]) => `${pad2(h)}:${pad2(m)}`;

// El servidor (Render) corre en UTC, pero el cronograma es en hora de Buenos
// Aires. Esta función devuelve SIEMPRE la hora y el día de la semana según
// America/Argentina/Buenos_Aires, sin importar el huso horario del server.
function horaArgentina(date = new Date()) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const get = (tipo) => partes.find((p) => p.type === tipo)?.value;
  const hour = parseInt(get("hour"), 10) % 24; // Intl a veces devuelve "24"
  const minute = parseInt(get("minute"), 10);
  const diasSemana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = diasSemana[get("weekday")];

  return { hour, minute, weekday };
}

export function horaArgentinaTexto(date = new Date()) {
  const { hour, minute } = horaArgentina(date);
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function getDayType(date = new Date()) {
  const d = horaArgentina(date).weekday;
  return d === 0 ? "dom" : d === 6 ? "sab" : "lv";
}

export function getSec(km) {
  return km < 12 ? 1 : km < 24 ? 2 : 3;
}

// Busca una estación por nombre o alias (insensible a mayúsculas/acentos simples).
export function buscarEstacion(nombre) {
  const norm = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const buscado = norm(nombre);
  return STATIONS.find(
    (st) =>
      norm(st.name) === buscado ||
      norm(st.name).includes(buscado) ||
      (st.aliases && st.aliases.some((a) => norm(a) === buscado || norm(a).includes(buscado)))
  );
}

// Detecta si el texto menciona alguna estación conocida.
export function detectarEstacion(texto) {
  const norm = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const t = norm(texto);
  for (const st of STATIONS) {
    const nombres = [st.name, ...(st.aliases || [])];
    if (nombres.some((n) => t.includes(norm(n)))) return st;
  }
  return null;
}

// Próximos trenes que pasan por una estación, en ambos sentidos (o uno solo).
// sentido: "moreno" (hacia Moreno), "once" (hacia Once), o null (ambos).
export function proximosTrenesEnEstacion({ estacionId, sentido = null, ahora = new Date(), cantidad = 3 }) {
  const dt = getDayType(ahora);
  const sched = S[dt];
  const { hour, minute } = horaArgentina(ahora);
  const nowMins = toMins(hour, minute);
  const OFFSET_M = [...OFFSET].reverse().map((o) => 71 - o);

  const resultado = { haciaMoreno: [], haciaOnce: [] };

  if (sentido !== "once") {
    const off = OFFSET[estacionId];
    for (const [h, m] of sched.once) {
      const depOrigin = toMins(h, m) + off;
      const until = depOrigin - nowMins;
      if (until >= -1 && resultado.haciaMoreno.length < cantidad) {
        resultado.haciaMoreno.push({
          hora: `${pad2(Math.floor(depOrigin / 60) % 24)}:${pad2(depOrigin % 60)}`,
          enMinutos: Math.max(0, until),
        });
      }
      if (resultado.haciaMoreno.length >= cantidad) break;
    }
  }

  if (sentido !== "moreno") {
    const off = OFFSET_M[15 - estacionId];
    for (const [h, m] of sched.moreno) {
      const depOrigin = toMins(h, m) + off;
      const until = depOrigin - nowMins;
      if (until >= -1 && resultado.haciaOnce.length < cantidad) {
        resultado.haciaOnce.push({
          hora: `${pad2(Math.floor(depOrigin / 60) % 24)}:${pad2(depOrigin % 60)}`,
          enMinutos: Math.max(0, until),
        });
      }
      if (resultado.haciaOnce.length >= cantidad) break;
    }
  }

  return resultado;
}

// Último y penúltimo tren del día, saliendo de cada terminal.
export function ultimosTrenes(ahora = new Date()) {
  const dt = getDayType(ahora);
  const on = S[dt].once;
  const mo = S[dt].moreno;
  return {
    diaTipo: dt,
    desdeOnce: {
      primero: fmt(on[0]),
      segundo: fmt(on[1]),
      ultimo: fmt(on[on.length - 1]),
      penultimo: fmt(on[on.length - 2]),
    },
    desdeMoreno: {
      primero: fmt(mo[0]),
      segundo: fmt(mo[1]),
      ultimo: fmt(mo[mo.length - 1]),
      penultimo: fmt(mo[mo.length - 2]),
    },
  };
}

export function precioPorKm(km) {
  const sec = getSec(km);
  return { seccion: sec, precioSube: PRECIOS[sec], precioSocial: PRECIO_SOCIAL[sec] };
}

// Servicio Diferencial: una sola vuelta por día, lunes a viernes, solo para
// en Once, Haedo y Moreno. Ampliado a L-V desde agosto 2026 (antes era
// lunes/miércoles/viernes). Verificar periódicamente que siga vigente.
export const DIFERENCIAL = {
  dias: "lunes a viernes",
  precio: 2600,
  paradas: ["Once", "Haedo", "Moreno"],
  haciaMoreno: { Once: "18:35", Haedo_llega: "19:16", Haedo_sale: "19:21", Moreno: "19:53" },
  haciaOnce: { Moreno: "6:29", Haedo_llega: "7:01", Haedo_sale: "7:05", Once: "7:50" },
};

export function proximoDiferencial(ahora = new Date()) {
  if (getDayType(ahora) !== "lv") {
    return { circulaHoy: false, motivo: "el Diferencial no circula fines de semana ni feriados" };
  }
  const { hour, minute } = horaArgentina(ahora);
  const nowMins = toMins(hour, minute);

  const salidas = [
    { desde: "Once", hacia: "Moreno", hora: DIFERENCIAL.haciaMoreno.Once },
    { desde: "Moreno", hacia: "Once", hora: DIFERENCIAL.haciaOnce.Moreno },
  ].map((s) => {
    const [h, m] = s.hora.split(":").map(Number);
    return { ...s, mins: toMins(h, m) };
  });

  const futuras = salidas.filter((s) => s.mins >= nowMins).sort((a, b) => a.mins - b.mins);
  if (!futuras.length) {
    return { circulaHoy: true, motivo: "ya salieron los dos servicios de hoy (Once y Moreno)" };
  }
  const proxima = futuras[0];
  return {
    circulaHoy: true,
    desde: proxima.desde,
    hacia: proxima.hacia,
    hora: proxima.hora,
    enMinutos: proxima.mins - nowMins,
  };
}

// "Locales": formaciones que arrancan VACÍAS en esa estación (no es que
// "cualquier tren pase por ahí" — es un servicio puntual designado). Datos
// tomados de la misma fuente que el sitio (objeto "especiales" en
// index.html). Solo aplican en días hábiles (lunes a viernes).
export const LOCALES = [
  { hora: "15:25", estacion: "Flores", direccion: "moreno" },
  { hora: "16:11", estacion: "Flores", direccion: "moreno" },
  { hora: "16:57", estacion: "Flores", direccion: "moreno" },
  { hora: "17:56", estacion: "Liniers", direccion: "moreno" },
  { hora: "18:41", estacion: "Liniers", direccion: "moreno" },
  { hora: "18:41", estacion: "Liniers", direccion: "once" },
  { hora: "19:28", estacion: "Liniers", direccion: "once" },
  { hora: "20:14", estacion: "Liniers", direccion: "once" },
  { hora: "05:28", estacion: "Merlo", direccion: "once" },
  { hora: "06:13", estacion: "Merlo", direccion: "once" },
  { hora: "07:01", estacion: "Merlo", direccion: "once" },
  { hora: "07:50", estacion: "Castelar", direccion: "once" },
  { hora: "08:36", estacion: "Castelar", direccion: "once" },
  { hora: "09:22", estacion: "Castelar", direccion: "once" },
];

// Próximos locales (formación vacía) de una estación, en lo que queda del día.
// Todos los horarios de locales de una estación, sin filtrar por hora (para
// poder distinguir "esta estación nunca tiene locales" de "hoy ya pasaron
// todos"). Ordenados de más temprano a más tarde.
export function horariosLocalesEstacion(nombreEstacion) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const buscado = norm(nombreEstacion);
  return LOCALES.filter((l) => norm(l.estacion) === buscado)
    .map((l) => ({ hora: l.hora, direccion: l.direccion === "moreno" ? "hacia Moreno" : "hacia Once" }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

export function proximosLocales(nombreEstacion, ahora = new Date()) {
  if (getDayType(ahora) !== "lv") return []; // los locales son solo días hábiles
  const { hour, minute } = horaArgentina(ahora);
  const nowMins = toMins(hour, minute);
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const buscado = norm(nombreEstacion);

  return LOCALES.filter((l) => norm(l.estacion) === buscado)
    .map((l) => {
      const [h, m] = l.hora.split(":").map(Number);
      return { ...l, mins: toMins(h, m) };
    })
    .filter((l) => l.mins >= nowMins - 1)
    .sort((a, b) => a.mins - b.mins)
    .map((l) => ({
      hora: l.hora,
      direccion: l.direccion === "moreno" ? "hacia Moreno" : "hacia Once",
      enMinutos: l.mins - nowMins,
    }));
}

// Todos los próximos locales de HOY, agrupados por estación (para cuando
// preguntan "¿hay algún local?" sin especificar cuál).
export function proximosLocalesTodasEstaciones(ahora = new Date()) {
  const estacionesConLocales = [...new Set(LOCALES.map((l) => l.estacion))];
  const resultado = {};
  for (const est of estacionesConLocales) {
    const prox = proximosLocales(est, ahora);
    if (prox.length) resultado[est] = prox;
  }
  return resultado;
}
