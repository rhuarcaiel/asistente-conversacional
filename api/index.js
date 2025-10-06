import { OpenAI } from 'openai';
import { body-parser } from 'body-parser';

export default async function (req, res) {
    // --- Cabeceras CORS ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    // --- Lógica de Login ---
    if (req.path === '/login' && req.method === 'POST') {
        try {
            const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${body.token}` } });
            if (!userInfoResponse.ok) throw new Error('Token inválido');
            const userInfo = await userInfoResponse.json();
            return res.status(200).json({ message: 'Login correcto', user: userInfo.email });
        } catch (error) {
            console.error('Error en la autenticación:', error);
            return res.status(401).json({ success: false, error: 'Token de acceso inválido.' });
        }
    }

    // --- Lógica de Conversación ---
    if (req.path === '/converse' && req.method === 'POST') {
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Eres un asistente de calendario conversacional y servicial. Analiza el historial de conversación con el usuario y responde de forma natural. Si el usuario pide crear o modificar algo, genera una propuesta JSON clara para que el usuario confirme. Si es una pregunta o un saludo, responde de forma conversacional sin proponer nada.`
                    },
                    ...body.history.map(item => ({ role: item.speaker === 'Tú' ? 'user' : 'assistant', content: item.text }))
                ],
                response_format: { type: 'text' }
            });
            const aiResponse = completion.choices[0].message.content;
            
            let proposal = null;
            try {
                const jsonBlock = aiResponse.match(/```json\n([\s\S]*?[\s\S]*?)\n/);
                if (jsonBlock) {
                    proposal = JSON.parse(jsonBlock[0]);
                }
            } catch (e) { /* No es una propuesta */ }
            
            return res.status(200).json({ response: aiResponse, proposal });

        } catch (error) {
            console.error('Error en la conversación con la IA:', error);
            return res.status(500).json({ success: false, error: 'Error al procesar la petición con la IA.' });
        }
    }

    // --- Lógica de Ejecución ---
    if (req.path === '/execute' && req.method === 'POST') {
        const proposal = body.proposal; const token = body.proposal; const token = body.token;

        if (proposal.intent === 'create') {
            try {
                const event = {
                    summary: proposal.summary,
                    start: { dateTime: proposal.start_datetime, timeZone: proposal.timezone },
                    end: { dateTime: new Date(new Date(proposal.start_datetime.getTime() + 60 * 60 * 1000).toISOString(), timeZone: proposal.timezone },
                };
                if (proposal.is_recurring && proposal.recurrence) {
                    let rrule = `RRULE:FREQ=${proposal.recurrence.frequency}`;
                    if (proposal.recurrence.day_of_week) rrule += `;BYDAY=${proposal.recurrence.day_of_week.slice(0, 2).toUpperCase()}`; event.recurrence = [rrule];
                }
                const calendarResponse = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
                if (!calendarResponse.ok) {
                    const errorBody = await calendarResponse.text();
                    return res.status(500).json({ success: false, error: `Error de Google Calendar: ${calendarResponse.status}. Detalles: ${errorBody}` });
                }
                const createdEvent = await calendarResponse.json();
                return res.status(200).json({ success: true, message: `Evento "${createdEvent.summary}" creado.` });
            } catch (error) {
                return res.status(500). json({ success: false, error: 'Error al crear el evento.' });
            }
        } else if (proposal.intent === 'delete_bulk') {
            try {
                console.log(`Buscando eventos para eliminar del ${proposal.start_date} al ${proposal.end_date}`);
                const searchUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${proposal.start_date}T00:00:00Z&timeMax=${proposal.end_date}T23:59:59Z`;
                const searchResponse = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                const eventsList = await searchResponse.json();
                let deletedCount = 0;
                for (const event of eventsList.items) {
                    if (proposal.summary_filter && !event.summary.toLowerCase().includes(proposal.summary_filter.toLowerCase())) { continue; }
                    const deleteResponse = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
                    if (deleteResponse.ok) { deletedCount++; console.log(`Evento eliminado: ${event.summary}`); }
                }
                return res.status(200).json({ success: true, message: `${deletedCount} eventos eliminados correctamente.` });
            } catch (error) {
                console.error('Error en eliminación masiva:', error);
                return res.status(500).json({ success: false, error: 'Error al eliminar los eventos.' });
            }
        }
    }
    return res.status(400).json({ error: 'Petición no válida.' });
}