// api/notificar.js
// Função: Receber dados, refinar geolocalização e enviar para Discord.

function campo(valor, limite = 1024) {
  if (valor === undefined || valor === null || valor === '') return 'N/D';
  return String(valor).slice(0, limite);
}

// Lista de ASN/Prefixos conhecidos de CDNs (Simplificado, use um banco real em produção)
// Se o IP for deste AS, a localização é do datacenter, não do usuário.
const CDN_ASNS = [
  'AS13335',  // Cloudflare
  'AS16509',  // Amazon CloudFront
  'AS15169',  // Google
  'AS8075',   // Microsoft
  'AS32934',  // Akamai
  'AS14618',  // Akamai
  'AS36459',  // Akamai
  'AS20940',  // WIX
  'AS16549',  // Google
  'AS396982', // Fastly
];

function ehCdn(asn) {
  if (!asn) return false;
  const asnStr = String(asn);
  return CDN_ASNS.some(asn => asnStr.includes(asn));
}

// Cálculo de distância Haversine (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Banco de dados simples de Centros Geográficos de Fusos Horários comuns no Brasil
// Para produção, use um banco de dados completo de fusos.
const FUSO_CENTROS = {
  "America/Sao_Paulo": { lat: -23.5505, lon: -46.6333, nome: "São Paulo" },
  "America/Fortaleza": { lat: -3.7178, lon: -38.5431, nome: "Fortaleza" },
  "America/Manaus": { lat: -3.1190, lon: -60.0217, nome: "Manaus" },
  "America/Cuiaba": { lat: -15.6014, lon: -56.0979, nome: "Cuiabá" },
  "America/Recife": { lat: -8.0476, lon: -34.8770, nome: "Recife" },
  "America/Bahia": { lat: -12.9777, lon: -38.5016, nome: "Salvador" },
  "America/Maceio": { lat: -9.6658, lon: -35.7353, nome: "Maceió" },
  "America/Campo_Grande": { lat: -20.4429, lon: -54.6167, nome: "Campo Grande" },
  "America/Rio_Branco": { lat: -9.9747, lon: -67.8103, nome: "Rio Branco" },
  "America/Porto_Velho": { lat: -8.7605, lon: -63.9004, nome: "Porto Velho" },
  "America/Boa_Vista": { lat: 2.8197, lon: -60.6733, nome: "Boa Vista" },
  "America/Santarem": { lat: -2.4431, lon: -54.7083, nome: "Santarém" },
  "America/Belem": { lat: -1.4558, lon: -48.4906, nome: "Belém" },
  "America/Eirunepe": { lat: -6.6505, lon: -69.8708, nome: "Rio Branco (Zona Oeste)" }
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'POST');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // Restringe requisições de navegadores a esta origem.
  const origem = req.headers.origin;
  if (origem) {
    try {
      const hostOrigem = new URL(origem).host;
      const hostSite = req.headers.host;
      if (hostOrigem !== hostSite) {
        return res.status(403).json({ error: 'Origem não permitida' });
      }
    } catch {
      return res.status(400).json({ error: 'Origem inválida' });
    }
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    return res.status(500).json({ error: 'DISCORD_WEBHOOK_URL não configurada' });
  }

  try {
    const webhookUrl = new URL(webhook);
    if (webhookUrl.protocol !== 'https:' ||
        webhookUrl.hostname !== 'discord.com' ||
        !/^\/api\/webhooks\/\d+\/[^/]+\/?$/.test(webhookUrl.pathname)) {
      return res.status(500).json({ error: 'URL de webhook inválida' });
    }
  } catch {
    return res.status(500).json({ error: 'URL de webhook inválida' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || body.autorizouCompartilhamento !== true ||
      !body.dados || typeof body.dados !== 'object') {
    return res.status(400).json({ error: 'Envio não autorizado ou dados inválidos' });
  }

  const d = body.dados;
  const meta = d.meta || {};

  // Validação básica para evitar payloads arbitrários.
  if (typeof d.ip !== 'string' || !d.ip || d.ip.length > 64 ||
      typeof d.navegador !== 'string' || d.navegador.length > 1024) {
    return res.status(400).json({ error: 'Formato do diagnóstico inválido' });
  }

  // ============================================
  // LÓGICA DE REFINAMENTO DE GEOLOCALIZAÇÃO
  // ============================================

  let latFinal = d.latitude;
  let lonFinal = d.longitude;
  let cidadeFinal = d.cidade;
  let regiaoFinal = d.regiao;
  let precisaoInfo = 'IP Base (API Pública)';
  let alerta = '';

  // 1. Verifica se é CDN
  const isCdn = ehCdn(d.asn);

  // 2. Verifica se temos um centro de fuso horário conhecido
  const fusoLocal = meta.fuso;
  const centroFuso = FUSO_CENTROS[fusoLocal];

  // 3. Calcula distância entre IP e Centro do Fuso
  let distanciaKm = null;
  if (latFinal && lonFinal && centroFuso) {
    distanciaKm = haversine(latFinal, lonFinal, centroFuso.lat, centroFuso.lon);
  }

  // 4. Regras de Correção
  if (isCdn) {
    // Se for CDN, o IP é do datacenter. Não confie nas coordenadas do IP.
    // Se houver fuso conhecido, use o centro do fuso como melhor estimativa.
    if (centroFuso) {
      latFinal = centroFuso.lat;
      lonFinal = centroFuso.lon;
      cidadeFinal = centroFuso.nome;
      regiaoFinal = 'Estimado por Fuso';
      precisaoInfo = 'CDN Detectada -> Fuso Horário';
      alerta = 'IP pertence a CDN. Coordenadas baseadas no fuso horário local.';
    } else {
      precisaoInfo = 'CDN Detectada (Sem Fuso Refinamento)';
      alerta = 'IP pertence a CDN. Precisão limitada à região do datacenter.';
    }
  } else if (distanciaKm !== null && distanciaKm > 50) {
    // Se não for CDN, mas a distância entre o IP e o centro do fuso for > 50km,
    // há alta probabilidade de o IP estar em uma cidade vizinha ou o usuário estar viajando.
    // Ajustamos para o centro do fuso horário, que é estatisticamente mais provável para usuários locais.
    latFinal = centroFuso.lat;
    lonFinal = centroFuso.lon;
    cidadeFinal = centroFuso.nome;
    regiaoFinal = 'Ajustado por Fuso';
    precisaoInfo = `IP distante (${distanciaKm.toFixed(0)}km) -> Ajuste Fuso`;
    alerta = `IP estava a ${distanciaKm.toFixed(0)}km do centro do fuso. Coordenadas ajustadas.`;
  } else {
    precisaoInfo = 'IP Direto (Alta Confiança)';
  }

  // 5. Montagem do Embed
  const embed = {
    title: '🌍 Diagnóstico Refinado',
    color: 0x6b21a8,
    description: `Dados refinados usando metadados locais e lógica de fuso horário.`,
    fields: [
      { name: 'IP público', value: campo(d.ip), inline: true },
      { name: 'ASN/CDN', value: campo(d.asn), inline: true },
      { name: 'Cidade (Ref.)', value: campo(cidadeFinal), inline: true },
      { name: 'Região (Ref.)', value: campo(regiaoFinal), inline: true },
      { name: 'País', value: campo(d.pais), inline: true },
      { name: 'Provedor', value: campo(d.provedor), inline: true },
      { name: 'Fuso Local', value: campo(meta.fuso), inline: true },
      { name: 'Lat. Final', value: campo(latFinal), inline: true },
      { name: 'Lon. Final', value: campo(lonFinal), inline: true },
      { name: 'Precisão', value: campo(precisaoInfo), inline: false },
      { name: 'Idioma', value: campo(meta.idiomas), inline: true },
      { name: 'Resolução', value: campo(meta.resolucao), inline: true },
      { name: 'Navegador', value: campo(meta.userAgent, 400), inline: false }
    ],
    timestamp: /^\d{4}-\d{2}-\d{2}T/.test(d.horario || '')
      ? d.horario
      : new Date().toISOString()
  };

  if (alerta) {
    embed.footer = { text: `⚠️ ${alerta}` };
  }

  try {
    const resposta = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [embed],
        allowed_mentions: { parse: [] }
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!resposta.ok) {
      console.error('[discord] Falha HTTP:', resposta.status);
      return res.status(502).json({ error: 'Discord não aceitou a notificação' });
    }

    return res.status(200).json({ success: true });
  } catch (erro) {
    console.error('[discord] Erro de conexão:', erro.message);
    return res.status(502).json({ error: 'Falha ao conectar ao Discord' });
  }
}
