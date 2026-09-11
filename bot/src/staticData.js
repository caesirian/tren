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
- Once - Moreno: ramal principal, eléctrico, 16 estaciones, circula todos los días del año con un servicio muy amplio (desde temprano en la madrugada hasta pasada la medianoche), pero NO es 24 horas continuas — hay un corte de varias horas en la madrugada. El horario exacto del primer y último tren de hoy está en la sección de horarios calculados en vivo si preguntan por eso puntualmente.
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
- Los colectivos y combinaciones específicas de cada estación del Sarmiento están en la sección "TRANSPORTE EN LA ZONA" que se agrega cuando preguntan por una estación puntual (datos reales, no aproximados).
- SUBTE (Buenos Aires): 6 líneas — A (Plaza de Mayo-San Pedrito/Flores), B (L.N. Alem-Juan M. de Rosas), C (Retiro-Constitución, conecta con casi todos los trenes de la zona norte/sur), D (Catedral-Congreso de Tucumán), E (Retiro-Plaza de los Virreyes), H (Facultad de Derecho-Hospitales). Se paga con SUBE, tarifa plana independiente de la distancia (más barata que el tren en general). Frecuencia habitual: 3-5 minutos en hora pico.
- OTRAS LÍNEAS DE TREN DEL AMBA (para quien pregunte por otro ramal, no confundir con el Sarmiento):
  · Línea Mitre: Retiro hacia Tigre, José León Suárez y Mitre (zona norte).
  · Línea Roca: Constitución hacia La Plata, Ezeiza, Alejandro Korn, Bosques/Temperley (zona sur).
  · Línea San Martín: Retiro hacia Pilar (zona oeste/noroeste).
  · Línea Belgrano Norte: Retiro hacia Villa Rosa (zona norte).
  · Línea Belgrano Sur: Buenos Aires (Puente Alsina/Barracas) hacia González Catán/Marinos del Crucero Gral. Belgrano (zona oeste/sur).
  · Todas también se pagan con SUBE, con tarifas por sección similares en lógica a las del Sarmiento.

CANALES OFICIALES PARA CONFIRMAR CASOS PUNTUALES (demoras del momento, horario exacto de un tren específico, cambios de último momento):
- Twitter/X: @TrenSarmiento (cuenta oficial) y @InfoTSarmiento
- trensarmientoenlinea.com.ar (semáforo de estado del servicio en vivo)

OBJETOS PERDIDOS Y ENCONTRADOS:
- Comunidad de pasajeros: el Grupo de Objetos Perdidos y Encontrados en Facebook — https://www.facebook.com/groups/2002389413227419/ — se recuperan mochilas, celulares y otras pertenencias todos los días gracias a otros pasajeros. Es el canal más rápido y el que recomendamos primero, tanto para reportar algo perdido como algo encontrado.
- Canal oficial (Trenes Argentinos/SOFSE): avisar al personal de la estación en el momento, o acercarse a la ventanilla de una estación con boletería:
  · Once: lunes a viernes de 5 a 22 hs, sábados de 5 a 21 hs.
  · Moreno: lunes a viernes de 6 a 22 hs, sábados de 6 a 21 hs.
  · Caballito: lunes a viernes de 7 a 22 hs, sábados de 7 a 20 hs.
- Si el objeto no aparece y querés hacer un reclamo formal, la Comisión Nacional de Regulación del Transporte (CNRT) atiende por 0800-333-0300 (línea gratuita).
- Para el reclamo, conviene tener a mano: descripción detallada del objeto, tren/horario/estación aproximados en que se perdió, y coche o vagón si se recuerda.
`.trim();

export const RESPUESTA_SIN_DATO =
  "No tengo ese dato específico confirmado (por ejemplo, el horario exacto de un tren puntual ahora mismo). Te recomiendo chequear @TrenSarmiento o trensarmientoenlinea.com.ar para confirmarlo al momento.";

export const RESPUESTA_ERROR_TECNICO =
  "Tuve un problema técnico momentáneo para procesar tu pregunta. Probá de nuevo en unos segundos, por favor 🙏";

