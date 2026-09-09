// src/schedule.js
// Cronograma real del ramal Once-Moreno, tomado de la misma fuente que usa
// trensarmientoenlinea.com.ar (array "S" en index.html), para que el bot dé
// horarios exactos y no solo frecuencias aproximadas.
//
// IMPORTANTE: si actualizás el cronograma en el sitio (index.html, variables
// STATIONS/PRECIOS/OFFSET/S), copiá el mismo cambio acá para que no se
// desincronicen. Última sincronización: 2026-09-09.

export const STATIONS = [
  { id: 0, name: "Once", km: 0, sec: 1 },
  { id: 1, name: "Caballito", km: 4, sec: 1 },
  { id: 2, name: "Flores", km: 7, sec: 1 },
  { id: 3, name: "Floresta", km: 9, sec: 1 },
  { id: 4, name: "Villa Luro", km: 11, sec: 1 },
  { id: 5, name: "Liniers", km: 13, sec: 2 },
  { id: 6, name: "Ciudadela", km: 16, sec: 2 },
  { id: 7, name: "Ramos Mejía", km: 19, sec: 2 },
  { id: 8, name: "Haedo", km: 22, sec: 2 },
  { id: 9, name: "Morón", km: 28, sec: 3 },
  { id: 10, name: "Castelar", km: 32, sec: 3 },
  { id: 11, name: "Ituzaingó", km: 35, sec: 3 },
  { id: 12, name: "San Antonio de Padua", km: 39, sec: 3, aliases: ["San A. de Padua", "San Antonio"] },
  { id: 13, name: "Merlo", km: 42, sec: 3 },
  { id: 14, name: "Paso del Rey", km: 46, sec: 3 },
  { id: 15, name: "Moreno", km: 52, sec: 3 },
];

export const PRECIOS = { 1: 310, 2: 420, 3: 520 };
export const PRECIO_SOCIAL = { 1: 139.5, 2: 189, 3: 234 };
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

export function getDayType(date = new Date()) {
  const d = date.getDay();
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
  const nowMins = toMins(ahora.getHours(), ahora.getMinutes());
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
    desdeOnce: { ultimo: fmt(on[on.length - 1]), penultimo: fmt(on[on.length - 2]) },
    desdeMoreno: { ultimo: fmt(mo[mo.length - 1]), penultimo: fmt(mo[mo.length - 2]) },
  };
}

export function precioPorKm(km) {
  const sec = getSec(km);
  return { seccion: sec, precioSube: PRECIOS[sec], precioSocial: PRECIO_SOCIAL[sec] };
}
