// Catalogo de propiedades servido por Vercel, con cache.
//
// Por que existe: el sitio le preguntaba a la API de GitHub desde el navegador de
// CADA visitante. Esa API permite 60 consultas por hora POR IP, asi que quien
// recargaba varias veces (tipico de Antonella mientras carga propiedades) se quedaba
// sin cuota y veia el listado vacio.
//
// Ahora pregunta una sola vez por minuto y le sirve la misma respuesta a todos.
//
// ⚠️ El token es imprescindible: sin identificarse, las funciones de Vercel comparten
// IP con miles de proyectos y las 60 consultas se agotan en segundos. Con token el
// limite es de 5.000 por hora y es propio. El token va en la variable de entorno
// GITHUB_TOKEN y NO tiene permisos: solo lee lo que ya es publico.
//
// Devuelve: { propiedades: [{ slug, raw }], config: {...} }
// El .md va crudo a proposito: lo parsea el sitio con su parseYAML de siempre, asi
// no hay dos parsers que puedan quedar desincronizados.

const REPO = 'solarpropiedades/CODIGO_VS';
const API = `https://api.github.com/repos/${REPO}/contents`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;

function ghHeaders() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'solarprop-web' };
  // Si no hay token igual funciona, solo que con la cuota compartida de Vercel.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// raw.githubusercontent devuelve 503 esporadicos. Sin reintento, una propiedad
// desaparecia del catalogo por un hipo del CDN.
async function fetchTexto(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
      if (r.status === 404) return null;          // no existe: no tiene sentido reintentar
    } catch (e) { /* error de red: se reintenta */ }
    if (i < intentos - 1) await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

export default async function handler(req, res) {
  try {
    // 1. Listar los .md de la carpeta de propiedades
    const lista = await fetch(`${API}/content/propiedades?ref=main`, { headers: ghHeaders() });
    if (!lista.ok) throw new Error('listado ' + lista.status);
    const archivos = (await lista.json()).filter(f => f.name && f.name.endsWith('.md'));

    // 2. Bajar cada .md. Se pide a raw.githubusercontent, que es un CDN y NO gasta
    //    la cuota de la API, asi que tener 5 o 50 propiedades da igual.
    const propiedades = (await Promise.all(archivos.map(async f => {
      const txt = await fetchTexto(`${RAW}/content/propiedades/${encodeURIComponent(f.name)}`);
      if (!txt) return null;   // una propiedad que falla no tira abajo el catalogo entero
      return { slug: f.name.replace(/\.md$/, ''), raw: txt };
    }))).filter(Boolean);

    // 3. El valor del dolar, en la misma respuesta: una consulta menos desde el sitio
    let config = null;
    const cfgTxt = await fetchTexto(`${RAW}/content/config/general.json`);
    if (cfgTxt) { try { config = JSON.parse(cfgTxt); } catch (e) { /* json roto: se ignora */ } }

    // Cache en el borde: GitHub recibe ~1 consulta por minuto sin importar cuanta
    // gente entre. stale-while-revalidate sirve la copia vieja mientras refresca,
    // asi nadie espera.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    return res.status(200).json({ propiedades, config });

  } catch (e) {
    // Que el sitio sepa que tiene que preguntarle a GitHub por su cuenta, como antes.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'catalogo no disponible' });
  }
}
