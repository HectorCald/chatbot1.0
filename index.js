const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const { Wit } = require('node-wit');

const app = express();
const port = process.env.PORT;

// Cargar datos de la empresa
const empresa = JSON.parse(fs.readFileSync('empresa.json', 'utf-8'));

// Crear cliente de WhatsApp
const client = new Client({ authStrategy: new LocalAuth() });

// Crear cliente de Wit.ai
const witClient = new Wit({ accessToken: process.env.WIT_ACCESS_TOKEN });

const ultimoSaludoPeriodo = new Map();
const primerMensaje = new Map();
const intentosNoEntiendo = new Map();

// Mapa para controlar el estado de desactivación del bot
const botInactivo = new Map();

client.on('qr', qr => {
    console.log('Escanea este código QR en WhatsApp:', qr);
});

client.on('ready', () => {
    console.log('🤖 ¡Bot de WhatsApp está listo!');
});

function getPeriodoDia() {
    const hora = new Date().getHours();
    if (hora >= 6 && hora < 12) return 'mañana';
    if (hora >= 12 && hora < 19) return 'tarde';
    return 'noche';
}

function getSaludo() {
    const hora = new Date().getHours();
    if (hora >= 6 && hora < 12) return "☀️ ¡Buenos días! Bienvenido a Brasas del Toro 🐂";
    if (hora >= 12 && hora < 19) return "🌤️ ¡Buenas tardes! Bienvenido a Brasas del Toro 🐂";
    return "🌙 ¡Buenas noches! Bienvenido a Brasas del Toro 🐂";
}

// Función para activar el bot después de 15 minutos
function activarBot(messageFrom) {
    setTimeout(() => {
        botInactivo.delete(messageFrom); // Reactivamos el bot para este cliente
    }, 15 * 60 * 1000); // 15 minutos
}

client.on('message', async message => {
    console.log(`📩 Mensaje recibido de ${message.from}: ${message.body}`);

    // Verificar si el bot está inactivo
    if (botInactivo.has(message.from)) {
        console.log('🤖 Bot desactivado temporalmente. Esperando respuesta de un empleado.');
        return;
    }

    if (!primerMensaje.has(message.from)) {
        await client.sendMessage(message.from, getSaludo());
        primerMensaje.set(message.from, true);
        ultimoSaludoPeriodo.set(message.from, getPeriodoDia());
        return;
    }

    const periodoActual = getPeriodoDia();
    if (ultimoSaludoPeriodo.get(message.from) !== periodoActual) {
        await client.sendMessage(message.from, getSaludo());
        ultimoSaludoPeriodo.set(message.from, periodoActual);
    }

    const mensajeLower = message.body.toLowerCase();
    let pedidoPosible = false;

    // Verifica si se mencionó algún platillo
    for (const platillo of empresa.menu.platillos) {
        if (mensajeLower.includes(platillo.nombre.toLowerCase())) {
            pedidoPosible = true;
            break;
        }
    }

    // Verifica si se mencionó alguna bebida
    if (!pedidoPosible) {
        for (const bebida of empresa.menu.bebidas) {
            if (mensajeLower.includes(bebida.nombre.toLowerCase())) {
                pedidoPosible = true;
                break;
            }
        }
    }

    // Verifica si el cliente menciona "pedido" o "pedir"
    if (!pedidoPosible && (mensajeLower.includes('pedido') || mensajeLower.includes('pedir'))) {
        pedidoPosible = true;
    }

    if (pedidoPosible) {
        await client.sendMessage(message.from, '📝 Parece que quieres realizar un pedido. Escribe todo en un *solo mensaje* a continuación y lo registraremos. ¡Gracias!');
        return;
    }

    // Contar intentos fallidos
    if (!intentosNoEntiendo.has(message.from)) {
        intentosNoEntiendo.set(message.from, 0);
    }

    let intentos = intentosNoEntiendo.get(message.from);
    
    try {
        const response = await witClient.message(message.body);
        const intent = response.intents.length > 0 ? response.intents[0].name : null;

        let reply = '❌ Lo siento, no entendí bien tu mensaje.';
        if (intent === 'consulta_menu') reply = formatMenu(empresa);
        else if (intent === 'consulta_horario') reply = `⏰ Nuestro horario: ${empresa.horario}`;
        else if (intent === 'consulta_contacto') reply = `📱 Contáctanos en: ${empresa.contacto}`;
        else if (intent === 'consulta_ubicacion') reply = `📍 Nos ubicamos en: ${empresa.ubicacion}`;
        else if (intent === 'consulta_pago') reply = `💳 Métodos de pago: ${empresa.pago}`;
        else if (intent === 'consulta_pedido') reply = `🍽️ ¿Qué te gustaría ordenar? escribe todo en un solo mensaje`;

        // Responder al cliente
        await client.sendMessage(message.from, reply);

        // Si no entendió el mensaje, contar el intento
        if (reply === '❌ Lo siento, no entendí bien tu mensaje.') {
            intentos++;
            intentosNoEntiendo.set(message.from, intentos);
        }
    } catch (error) {
        console.error('❌ Error:', error);
        await client.sendMessage(message.from, '❌ Lo siento, no entendí bien tu mensaje.');
        intentos++;
        intentosNoEntiendo.set(message.from, intentos);
    }

    // Si el cliente ha fallado 3 veces, desactivar el bot por 15 minutos
    if (intentos >= 3) {
        await client.sendMessage(message.from, '😞 Parece que estás teniendo problemas para comunicarte. En breve un miembro del personal te ayudará. El bot se desactivará por 15 minutos.');
        botInactivo.set(message.from, true);
        activarBot(message.from); // Reactivación del bot después de 15 minutos
        intentosNoEntiendo.delete(message.from); // Resetea el contador de intentos
    }

    // Aquí procesamos el pedido
    if (pedidoPosible && !intentosNoEntiendo.has(message.from)) {
        // Si el cliente escribe el pedido
        await client.sendMessage(message.from, '🍽️ Pedido registrado. Un miembro del personal se comunicará contigo en breve para confirmar el pedido y el pago.');
        // Lógica para registrar el pedido y enviar la confirmación al administrador o al sistema de pedidos
    }
});

// Detectar cuando el personal responde en el chat
client.on('message_create', async (message) => {
    if (message.from === message.to) {  // Esto verifica que el mensaje enviado es del mismo número de WhatsApp (bot) y no otro
        console.log('👨‍💼 El personal respondió al cliente.');

        // Desactivar el bot para este cliente mientras se responde
        botInactivo.set(message.to, true);

        // Reactivar el bot después de 10 minutos si no hay más respuestas
        setTimeout(() => {
            botInactivo.delete(message.to);  // Reactivamos el bot para este cliente
        }, 10 * 60 * 1000); // 10 minutos
    }
});

function formatMenu(empresa) {
    let menuText = `🔥 **Menú de Brasas del Toro** 🐂\n\n🌟 **Especialidad:** ${empresa.menu.especialidad}\n\n🍖 **Nuestros Platillos:**\n`;
    empresa.menu.platillos.forEach(platillo => menuText += `• ${platillo.nombre} - $${platillo.precio}\n`);
    menuText += `\n🥤 **Bebidas:**\n`;
    empresa.menu.bebidas.forEach(bebida => menuText += `• ${bebida.nombre} - $${bebida.precio}\n`);
    return menuText + '\n💡 ¡Te esperamos en Brasas del Toro! 🔥';
}

client.initialize();
app.listen(port, () => console.log(`🚀 Servidor corriendo en http://localhost:${port}`));
