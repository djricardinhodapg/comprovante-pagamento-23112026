
 // Função Node.js da Vercel: POST /api/notificar
// A URL do Discord é mantida em Environment Variables, não no HTML.

function campo(valor, limite = 1024) {
  if (valor === undefined || valor === null || valor === '') return 'Não disponível';
  return String(valor).slice(0, limite);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'POST');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // Restringe requisições de navegadores a esta origem.
  // Não substitui autenticação nem uma proteção dedicada contra spam.
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

  // Validação básica para evitar payloads arbitrários.
  if (typeof d.ip !== 'string' || !d.ip || d.ip.length > 64 ||
      typeof d.navegador !== 'string' || d.navegador.length > 1024) {
    return res.status(400).json({ error: 'Formato do diagnóstico inválido' });
  }

  const embed = {
    title: '🌍 Diagnóstico compartilhado', // EDITE AQUI O TÍTULO NO DISCORD
    color: 0x6b21a8,                   // EDITE AQUI A COR NO DISCORD
    description: 'Dados enviados por uma ação explícita do visitante.',
    fields: [
      { name: 'IP público', value: campo(d.ip), inline: true },
      { name: 'Cidade', value: campo(d.cidade), inline: true },
      { name: 'Região', value: campo(d.regiao), inline: true },
      { name: 'País', value: campo(d.pais), inline: true },
      { name: 'Provedor', value: campo(d.provedor), inline: true },
      { name: 'Fuso horário', value: campo(d.fusoHorario), inline: true },
      { name: 'Navegador', value: campo(d.navegador, 600) },
      { name: 'Idioma', value: campo(d.idioma) }
      { name: "Latitude aproximada", value: campo(d.latitude), inline: true },
      { name: "Longitude aproximada", value: campo(d.longitude), inline: true }

    ],
    timestamp: /^\d{4}-\d{2}-\d{2}T/.test(d.horario || '')
      ? d.horario
      : new Date().toISOString()
  };

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
