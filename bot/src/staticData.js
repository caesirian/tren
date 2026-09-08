// src/staticData.js
// Datos fijos que alimentan al bot. Actualizalos cuando cambien tarifas,
// frecuencias oficiales o el recorrido de ramales. No requieren ninguna API.
//
// Formato libre en texto: Gemini lee este bloque como contexto, no hace
// falta una estructura rígida. Mantené fechas de "última actualización"
// para que el bot pueda avisar si la info podría estar vieja.

export const TREN_SARMIENTO_INFO = `
== TREN SARMIENTO — INFORMACIÓN DE REFERENCIA ==
Última actualización de este bloque: 2026-09-04 (actualizar a mano cuando cambie algo)

RECORRIDO Y RAMALES:
- Ramal principal: Estación Once (CABA) - Moreno.
- Servicios diferenciales/expresos en ciertos horarios pico: paran en menos estaciones (verificar cartelería y anuncios en estación, puede variar).
- Estaciones intermedias principales: Caballito, Flores, Liniers, Ciudadela, Ramos Mejía, Haedo, Morón, Castelar, Ituzaingó, Merlo, Paso del Rey, Moreno.

FRECUENCIAS ORIENTATIVAS (pueden variar por demoras u obras — confirmar siempre con el semáforo de estado en vivo):
- Hora pico (mañana y tarde, días hábiles): cada 6-10 minutos aproximadamente.
- Fuera de pico (días hábiles): cada 10-15 minutos aproximadamente.
- Fines de semana y feriados: cada 15-20 minutos aproximadamente.
- Primer/último servicio: consultar siempre en la app oficial "Trenes Argentinos" o en la estación, varía por día.

TARIFAS SUBE (orientativas, actualizar cuando el gobierno anuncie cambios):
- El tren usa tarifa por tramo/distancia, se paga con tarjeta SUBE al ingresar y salir del andén (en muchas estaciones).
- Boleto Social, tarifa jubilados y estudiantes tienen descuentos vigentes vía SUBE.
- Para el valor exacto vigente del boleto, siempre recomendar verificar en la app SUBE o en argentina.gob.ar/sube, porque las tarifas de trenes AMBA se actualizan con cierta frecuencia por decisión del gobierno nacional.

CONEXIONES CON OTROS TRANSPORTES (AMBA):
- Estación Once: combina con Línea A y H de subte, y numerosas líneas de colectivo.
- Estación Liniers/Ciudadela: combina con colectivos hacia zona oeste del GBA.
- Estación Morón/Castelar/Merlo: combinan con líneas de colectivo locales de cada partido.
- Boleto combinado / integración tarifaria SUBE puede aplicar en combinaciones tren-colectivo-subte dentro de una ventana horaria: confirmar condición vigente en app SUBE.

CANALES OFICIALES PARA CONFIRMAR EN TIEMPO REAL:
- App "Trenes Argentinos" (SOFSE): horarios en vivo y alertas de demora.
- Twitter/X: @TrenSarmiento
- trensarmientoenlinea.com.ar (semáforo de estado del servicio en vivo)
`.trim();

export const RESPUESTA_SIN_DATO =
  "No tengo ese dato confirmado en la info que manejo. Te recomiendo chequear la app oficial Trenes Argentinos, la cuenta @TrenSarmiento o trensarmientoenlinea.com.ar para confirmarlo al momento.";
