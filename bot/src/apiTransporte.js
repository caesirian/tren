// src/apiTransporte.js
// Cliente OPCIONAL para la API Transporte del GCBA (apitransporte.buenosaires.gob.ar).
//
// IMPORTANTE: al armar este bot (sept. 2026), la página oficial de datos
// abiertos de Buenos Aires indicaba que los feeds de trenes en tiempo real
// de esta API estaban SUSPENDIDOS / en revisión. Antes de activar esto:
//   1. Registrate en https://www.buenosaires.gob.ar/form/formulario-de-registro-api-transporte
//   2. Probá manualmente el endpoint de alertas de trenes con tus credenciales
//   3. Si responde con datos frescos, activá USE_API_TRANSPORTE=true en .env
//
// Si no está disponible o no tenés credenciales, el bot sigue funcionando
// normalmente con el semáforo de Firestore + los datos fijos.

const BASE_URL = "https://apitransporte.buenosaires.gob.ar";

export async function getAlertasTrenes() {
  if (process.env.USE_API_TRANSPORTE !== "true") return null;

  const clientId = process.env.API_TRANSPORTE_CLIENT_ID;
  const clientSecret = process.env.API_TRANSPORTE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    // Endpoint de referencia según documentación pública — verificar el path
    // exacto en https://www.buenosaires.gob.ar/desarrollourbano/transporte/apitransporte/api-doc
    // ya que puede cambiar entre versiones de la API.
    const url = `${BASE_URL}/trenes/serviceAlerts?client_id=${clientId}&client_secret=${clientSecret}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error("API Transporte respondió con error:", res.status);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Error consultando API Transporte:", err.message);
    return null;
  }
}
