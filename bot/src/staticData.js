// src/staticData.js
// Datos fijos que alimentan al bot. Actualizalos cuando cambien tarifas,
// frecuencias oficiales o el recorrido de ramales. No requieren ninguna API.
//
// Formato libre en texto: Gemini lee este bloque como contexto, no hace
// falta una estructura rígida. Mantené fechas de "última actualización"
// para que el bot pueda avisar si la info podría estar vieja.

export const TREN_SARMIENTO_INFO = `
== TREN SARMIENTO — INFORMACIÓN DE REFERENCIA ==
Última actualización de este bloque: 2026-09-08 (actualizar cuando cambien tarifas o el cronograma oficial)

RAMALES DEL FERROCARRIL SARMIENTO:
- Once - Moreno: ramal principal, eléctrico, 16 estaciones, circula todos los días del año, las 24 horas.
- Moreno - Mercedes: diésel, 62 km, para en Luján y General Rodríguez, pocas frecuencias diarias.
- Merlo - Lobos: diésel, 68 km, para en Marcos Paz y Las Heras, frecuencia limitada.
- Tren a Bragado: larga distancia, 363 km, sale lunes, miércoles y viernes, dura aprox. 5 h 20 min.

ESTACIONES DEL RAMAL ONCE-MORENO (en orden):
Once, Caballito, Flores, Floresta, Villa Luro, Liniers, Ciudadela, Ramos Mejía,
Haedo, Morón, Castelar, Ituzaingó, San Antonio de Padua, Merlo, Paso del Rey, Moreno.

TIEMPO DE VIAJE:
- Once a Moreno (servicio directo, sin demoras): aproximadamente 65-70 minutos.

FRECUENCIAS (ramal Once-Moreno):
- Hora pico (mañana y tarde, días hábiles): un tren cada 9 minutos aproximadamente.
- Fuera de hora pico en días hábiles, y fines de semana/feriados: entre 15 y 27 minutos según franja.
- El rango general oficial es de 9 a 27 minutos según día y horario.
- Estas frecuencias son el cronograma oficial vigente; pueden variar por demoras puntuales u obras — para eso confiar en el semáforo de estado en vivo si está disponible en el contexto.

TARIFAS SUBE VIGENTES (servicio común, septiembre 2026 — Resolución 27/2026):
- Sección corta: $450 con SUBE registrada.
- Sección media: $640 con SUBE registrada.
- Sección larga (más de 24 km): $790 con SUBE registrada.
- SUBE sin registrar: paga el doble de la tarifa de cada sección.
- Efectivo (boleto plano, sin SUBE): $1.600, sin importar la distancia.
- Tarifa Social: 55% de descuento para jubilados/pensionados con haber mínimo, beneficiarios de AUH, personal de casas particulares, ex combatientes de Malvinas y Jefes de Hogar (requiere atributo social cargado en la SUBE, se gestiona en ANSES o boletería).
- Jubilados y pensionados con haber mínimo viajan GRATIS de lunes a viernes de 9 a 17 hs y de 21 a 4 hs, y todo el día sábados, domingos y feriados.
- Descuento por combinación: si combinás con otro transporte (colectivo, subte, otro tren) dentro de las 2 horas, el segundo boleto sale con descuento pagando con SUBE.
- Las tarifas suelen actualizarse mes a mes por resolución oficial: si preguntan por un mes futuro, aclarar que puede haber un nuevo valor y sugerir confirmar el monto exacto vigente ese día.

SERVICIO DIFERENCIAL (opcional, más caro, no es el servicio común):
- Circula de lunes a viernes (se amplió desde agosto 2026; antes era solo lunes/miércoles/viernes), una sola vuelta por día.
- Solo para en Once, Haedo y Moreno.
- Boleto: $2.600, tarifa única (no varía con la sección ni tiene descuento social).
- Incluye asientos reclinables, aire acondicionado, baños a bordo y kiosco (son los coches del tren de larga distancia a Bragado).
- Se compra antes de subir (plataforma oficial online o boletería de larga distancia), no se vende a bordo.

CONEXIONES CON OTROS TRANSPORTES (AMBA):
- Estación Once: combina con subte Línea A y Línea H, y numerosas líneas de colectivo.
- Estación Liniers/Ciudadela: combina con colectivos hacia zona oeste del GBA.
- Estación Morón/Castelar/Merlo: combinan con líneas de colectivo locales de cada partido.

CANALES OFICIALES PARA CONFIRMAR CASOS PUNTUALES (demoras del momento, horario exacto de un tren específico, cambios de último momento):
- App "Trenes Argentinos" (SOFSE).
- Twitter/X: @TrenSarmiento
- trensarmientoenlinea.com.ar (semáforo de estado del servicio en vivo)
`.trim();

export const RESPUESTA_SIN_DATO =
  "No tengo ese dato específico confirmado (por ejemplo, el horario exacto de un tren puntual ahora mismo). Te recomiendo chequear la app oficial Trenes Argentinos, la cuenta @TrenSarmiento o trensarmientoenlinea.com.ar para confirmarlo al momento.";

