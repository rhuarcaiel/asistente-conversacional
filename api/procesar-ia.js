import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  // Parsear cuerpo - En Vercel ya viene parseado, no es necesario hacerlo manualmente
  let body;
  try {
    body = req.body;
  } catch (error) {
    return res.status(400).json({ error: 'JSON inválido.' });
  }

  // LOGIN
  if (body.action === 'login' && body.token) {
    try {
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${body.token}` }
      });
      if (!userInfoResponse.ok) throw new Error('Token inválido');
      const userInfo = await userInfoResponse.json();
      return res.status(200).json({ message: 'Login correcto', user: userInfo.email });
    } catch (error) {
      return res.status(401).json({ error: 'Token de acceso inválido.' });
    }
  }

  // CONVERSACIÓN
  if (body.action === 'converse' && body.history) {
    try {
      const messages = [
        {
          role: 'system',
          content: `Eres un asistente de calendario conversacional. Si el usuario pide crear o eliminar eventos, responde con un bloque JSON dentro de \`\`\`json\n{...}\n\`\`\`. Si no, responde normalmente.`
        },
        ...body.history.map(item => ({
          role: item.speaker === 'Tú' ? 'user' : 'assistant',
          content: item.text
        }))
      ];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        response_format: { type: 'text' }
      });

      const aiResponse = completion.choices[0].message.content;
      let proposal = null;

      const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          proposal = JSON.parse(jsonMatch[1]);
        } catch (e) {
          console.warn('JSON inválido en propuesta:', e);
        }
      }

      return res.status(200).json({ response: aiResponse, proposal });
    } catch (error) {
      console.error('Error con OpenAI:', error);
      return res.status(500).json({ error: 'Error al procesar con IA.' });
    }
  }

  // EJECUCIÓN
  if (body.action === 'execute' && body.proposal && body.token) {
    const { proposal, token } = body;

    if (proposal.intent === 'create') {
      try {
        const start = new Date(proposal.start_datetime);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // +1h

        const event = {
          summary: proposal.summary,
          start: { dateTime: start.toISOString(), timeZone: proposal.timezone || 'UTC' },
          end: { dateTime: end.toISOString(), timeZone: proposal.timezone || 'UTC' }
        };

        if (proposal.is_recurring && proposal.recurrence) {
          let rrule = `RRULE:FREQ=${proposal.recurrence.frequency}`;
          if (proposal.recurrence.day_of_week) {
            rrule += `;BYDAY=${proposal.recurrence.day_of_week.slice(0, 2).toUpperCase()}`;
          }
          event.recurrence = [rrule];
        }

        const calendarRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(event)
        });

        if (!calendarRes.ok) {
          const errText = await calendarRes.text();
          return res.status(500).json({ error: `Google Calendar error: ${errText}` });
        }

        const created = await calendarRes.json();
        return res.status(200).json({ message: `Evento "${created.summary}" creado.` });
      } catch (error) {
        console.error('Error al crear evento:', error);
        return res.status(500).json({ error: 'No se pudo crear el evento.' });
      }
    }

    if (proposal.intent === 'delete_bulk') {
      try {
        const timeMin = new Date(proposal.start_date);
        const timeMax = new Date(proposal.end_date);
        timeMax.setHours(23, 59, 59, 999);

        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.searchParams.append('timeMin', timeMin.toISOString());
        url.searchParams.append('timeMax', timeMax.toISOString());

        const searchRes = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const events = await searchRes.json();
        let deleted = 0;

        for (const event of events.items || []) {
          if (proposal.summary_filter && !event.summary.toLowerCase().includes(proposal.summary_filter.toLowerCase())) {
            continue;
          }
          const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          });
          if (delRes.ok) deleted++;
        }

        return res.status(200).json({ message: `${deleted} eventos eliminados correctamente.` });
      } catch (error) {
        console.error('Error al eliminar eventos:', error);
        return res.status(500).json({ error: 'No se pudieron eliminar los eventos.' });
      }
    }

    return res.status(400).json({ error: 'Intent no soportado.' });
  }

  return res.status(400).json({ error: 'Petición no válida.' });
}
