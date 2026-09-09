// Ficha de propiedad con Open Graph resuelto EN EL SERVIDOR.
//
// Por que existe: WhatsApp, Instagram y Facebook NO ejecutan JavaScript. Nuestras
// fichas se arman en el navegador leyendo GitHub, asi que el robot de WhatsApp veia
// una pagina vacia y mostraba el link pelado. Esta funcion lee el .md de la propiedad
// y devuelve el MISMO html de siempre pero con el titulo, la descripcion y la foto
// ya escritos en el <head>.
//
// Ruta: /p/<slug>  (definida en vercel.json)
// El navegador recibe el html normal y el JS del cliente arma la ficha solo, porque
// ya soporta leer el slug del path (pathSlug en propiedades/index.html).
//
// RED DE SEGURIDAD: si cualquier cosa falla (GitHub caido, propiedad inexistente,
// .md raro), se devuelve la pagina tal cual esta hoy. Nunca se rompe la ficha.

const REPO = 'solarpropiedades/CODIGO_VS';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
// Dominio publico (el que va en og:url y en las imagenes). El sitio tambien responde
// en codigo-vs.vercel.app, pero el canonico es este: si no, Google ve el contenido
// duplicado en dos dominios.
const SITE = 'https://www.solarprop.com.ar';
const IMG_FALLBACK = `${SITE}/fotos/ISOLOGO.PNG`;

// Escapa para meter texto dentro de un atributo HTML
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Parser del frontmatter YAML. Mismo criterio que parseYAML del sitio: alcanza con
// claves simples, listas con guion y bloques (> / |). No se usa libreria a proposito.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let listKey = null;
  let blockKey = null;
  let blockLines = [];

  const flushBlock = () => {
    if (blockKey) {
      out[blockKey] = blockLines.join(' ').replace(/\s+/g, ' ').trim();
      blockKey = null;
      blockLines = [];
    }
  };

  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\r$/, '');

    // Dentro de un bloque (> o |): se acumula mientras venga indentado
    if (blockKey) {
      if (/^\s+\S/.test(line) || line.trim() === '') {
        if (line.trim()) blockLines.push(line.trim());
        continue;
      }
      flushBlock();
    }

    // Item de lista
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && listKey) {
      const v = li[1].trim().replace(/^["']|["']$/g, '');
      if (v) out[listKey].push(v);
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = null;
    const key = kv[1];
    let val = kv[2].trim();

    if (val === '' ) { out[key] = ''; listKey = key; out[key] = []; continue; }
    if (val === '>-' || val === '>' || val === '|' || val === '|-') { blockKey = key; blockLines = []; continue; }

    val = val.replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  flushBlock();

  // Las claves que quedaron como [] vacio y nunca recibieron items -> string vacio
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k]) && out[k].length === 0) out[k] = '';
  }
  return out;
}

function fmtPrecio(p) {
  const n = Number(p.precio);
  if (!isFinite(n) || !n) return '';
  const pref = (p.moneda || 'USD').toUpperCase() === 'ARS' ? '$' : 'U$S';
  return `${pref} ${n.toLocaleString('es-AR')}`;
}

// Arma la descripcion corta que se ve abajo del titulo en WhatsApp
function armarDescripcion(p) {
  const bits = [];
  const precio = fmtPrecio(p);
  if (precio) bits.push(precio);
  if (p.metros_cuadrados) bits.push(`${p.metros_cuadrados} m²`);
  if (p.ambientes) bits.push(`${p.ambientes} amb.`);
  if (p.dormitorios) bits.push(`${p.dormitorios} dorm.`);
  if (p.banos) bits.push(`${p.banos} ${Number(p.banos) === 1 ? 'baño' : 'baños'}`);

  const ubic = [p.zona, p.localidad].filter(Boolean).join(', ');
  let out = bits.join(' · ');
  if (ubic) out += (out ? ' — ' : '') + ubic;

  // Si hay descripcion cargada, se suma un pedacito
  const d = String(p.descripcion || '').replace(/\s+/g, ' ').trim();
  if (d) {
    const resto = 200 - out.length;
    if (resto > 40) out += ' · ' + (d.length > resto ? d.slice(0, resto - 1).trim() + '…' : d);
  }
  return out || 'Propiedad en venta o alquiler en la Patagonia argentina.';
}

function primeraFoto(p) {
  // Decap guarda 'fotos' como texto si hay una sola imagen y como lista si hay varias
  const f = Array.isArray(p.fotos) ? p.fotos.filter(Boolean)
          : (typeof p.fotos === 'string' && p.fotos.trim() ? [p.fotos.trim()] : []);
  if (!f.length) return IMG_FALLBACK;
  const src = String(f[0]).trim();
  if (/^https?:\/\//i.test(src)) return src;
  return SITE + (src.startsWith('/') ? src : '/' + src);
}

// Reemplaza el contenido de una meta ya existente en el html
function setMeta(html, attr, name, value) {
  const re = new RegExp(`(<meta\\s+${attr}=["']${name}["']\\s+content=["'])[^"']*(["'])`, 'i');
  return re.test(html) ? html.replace(re, `$1${esc(value)}$2`) : html;
}

export default async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || '').replace(/[^A-Za-z0-9._-]/g, '');

  // Base: el html de la ficha tal cual esta publicado. Se pide al propio deploy;
  // ese path es un archivo real, asi que lo sirve el filesystem y no vuelve aca.
  let html;
  try {
    // Para el HTML base se usa el host real de la request: asi funciona igual en el
    // dominio propio, en el .vercel.app y en los deploys de preview.
    const self = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const base = await fetch(`${self}/propiedades/index.html`);
    if (!base.ok) throw new Error('base ' + base.status);
    html = await base.text();
  } catch (e) {
    // Sin la base no hay nada que servir: que Vercel siga su curso normal
    res.setHeader('Location', `/propiedades/?p=${encodeURIComponent(slug)}`);
    return res.status(302).end();
  }

  try {
    if (slug) {
      const r = await fetch(`${RAW}/content/propiedades/${slug}.md`);
      if (r.ok) {
        const p = parseFrontmatter(await r.text());
        if (p && p.titulo) {
          const titulo = `${p.titulo}${p.codigo ? ` (${p.codigo})` : ''} · Solar Propiedades`;
          const desc = armarDescripcion(p);
          const img = primeraFoto(p);
          const url = `${SITE}/p/${slug}`;

          html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(titulo)}</title>`);
          html = setMeta(html, 'name', 'description', desc);
          html = setMeta(html, 'property', 'og:title', titulo);
          html = setMeta(html, 'property', 'og:description', desc);
          html = setMeta(html, 'property', 'og:image', img);
          html = setMeta(html, 'property', 'og:image:alt', p.titulo);
          html = setMeta(html, 'property', 'og:url', url);
          // El canonical viene del html base apuntando a /propiedades: cada ficha tiene
          // que apuntarse a si misma, si no Google no las indexa por separado.
          html = html.replace(/<link rel="canonical" href="[^"]*"\s*\/>/i,
                              `<link rel="canonical" href="${esc(url)}" />`);
          html = setMeta(html, 'property', 'og:type', 'article');
          html = setMeta(html, 'name', 'twitter:title', titulo);
          html = setMeta(html, 'name', 'twitter:description', desc);
          html = setMeta(html, 'name', 'twitter:image', img);
          // Las fotos de las propiedades no son 1200x630: sin medidas fijas,
          // WhatsApp y Facebook se acomodan solos.
          html = html.replace(/\s*<meta property="og:image:(width|height)" content="\d+" \/>/gi, '');
        }
      }
    }
  } catch (e) {
    // Se sirve la pagina sin personalizar. Mejor eso que un error.
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Cache en el borde: no se pega a GitHub en cada request (evita rate limit)
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  return res.status(200).send(html);
}
