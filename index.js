const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
require('dotenv').config();
const { Wit } = require('node-wit');

const app = express();
const port = process.env.PORT;

// Cargar datos de la empresa
let empresa;
try {
    empresa = JSON.parse(fs.readFileSync('empresa.json', 'utf-8'));
    if (!empresa) {
        throw new Error("El archivo empresa.json está vacío o no es válido.");
    }
} catch (error) {
    console.error('❌ Error al cargar empresa.json:', error.message);
    process.exit(1); // Detener la ejecución del script si hay un error
}

// Crear cliente de WhatsApp
const client = new Client({ authStrategy: new LocalAuth() });

// Crear cliente de Wit.ai
const witClient = new Wit({ accessToken: process.env.WIT_ACCESS_TOKEN });

const ultimoSaludoPeriodo = new Map();
const primerMensaje = new Map();
const intentosNoEntiendo = new Map();

// Mapa para controlar el estado de desactivación del bot
const botInactivo = new Map();

// Mapa para controlar si el cliente está en proceso de realizar un pedido
const enProcesoDePedido = new Map();

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
    if (hora >= 6 && hora < 12) return "☀️ ¡Buenos días! Bienvenido a " + empresa.nombre + " 🐂";
    if (hora >= 12 && hora < 19) return "🌤️ ¡Buenas tardes! Bienvenido a " + empresa.nombre + " 🐂";
    return "🌙 ¡Buenas noches! Bienvenido a " + empresa.nombre + " 🐂";
}

// Función para activar el bot después de 15 minutos
function activarBot(messageFrom) {
    setTimeout(() => {
        botInactivo.delete(messageFrom); // Reactivamos el bot para este cliente
        console.log(`🤖 Bot reactivado para ${messageFrom}.`);
    }, 15 * 60 * 1000); // 15 minutos
}

client.on('message', async message => {
    console.log(`📩 Mensaje recibido de ${message.from}: ${message.body}`);

    // Verificar si el bot está inactivo para este cliente
    if (botInactivo.has(message.from)) {
        console.log('🤖 Bot desactivado temporalmente. Esperando respuesta de un empleado.');
        return;
    }

    // Enviar saludo inicial si es el primer mensaje del cliente
    if (!primerMensaje.has(message.from)) {
        await client.sendMessage(message.from, getSaludo());
        primerMensaje.set(message.from, true);
        ultimoSaludoPeriodo.set(message.from, getPeriodoDia());
        return;
    }

    // Enviar saludo si ha cambiado el período del día
    const periodoActual = getPeriodoDia();
    if (ultimoSaludoPeriodo.get(message.from) !== periodoActual) {
        await client.sendMessage(message.from, getSaludo());
        ultimoSaludoPeriodo.set(message.from, periodoActual);
    }

    const mensajeLower = message.body.toLowerCase();

    // Verificar si el cliente está en proceso de realizar un pedido
    if (enProcesoDePedido.has(message.from)) {
        // Registrar el pedido y desactivar el bot por 15 minutos
        await client.sendMessage(message.from, '🍽️ Pedido registrado. En unos minutos alguien del personal confirmará tu pedido y la forma de pago.');
        enProcesoDePedido.delete(message.from); // Eliminar el estado de "en proceso de pedido"
        botInactivo.set(message.from, true); // Desactivar el bot por 15 minutos
        activarBot(message.from); // Reactivar el bot después de 15 minutos
        return;
    }

    // Verificar si el mensaje contiene alguna palabra del menú
    let pedidoPosible = false;
    if (empresa.menu && empresa.menu.platillos) {
        for (const platillo of empresa.menu.platillos) {
            if (mensajeLower.includes(platillo.nombre.toLowerCase())) {
                pedidoPosible = true;
                break;
            }
        }
    }
    if (empresa.menu && empresa.menu.bebidas) {
        for (const bebida of empresa.menu.bebidas) {
            if (mensajeLower.includes(bebida.nombre.toLowerCase())) {
                pedidoPosible = true;
                break;
            }
        }
    }

    // Si se detecta un posible pedido, pedir más detalles
    if (pedidoPosible) {
        await client.sendMessage(message.from, '📝 Parece que quieres realizar un pedido. Escríbelo más detallado y en un solo mensaje a continuación.');
        enProcesoDePedido.set(message.from, true); // Marcar que el cliente está en proceso de realizar un pedido
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
        else if (intent === 'consulta_horario') reply = `⏰ Nuestro horario: ${empresa.horario || "No disponible"}`;
        else if (intent === 'consulta_contacto') reply = `📱 Contáctanos en: ${empresa.contacto || "No disponible"}`;
        else if (intent === 'consulta_ubicacion') reply = `📍 Nos ubicamos en: ${empresa.ubicacion || "No disponible"}`;
        else if (intent === 'consulta_pago') reply = `💳 Métodos de pago: ${empresa.pago || "No disponible"}`;
        else if (intent === 'consulta_pedido') reply = `🍽️ ¿Qué te gustaría ordenar? Escribe todo en un solo mensaje.`;

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
});

function formatMenu(empresa) {
    if (!empresa.menu || !empresa.menu.platillos) {
        return "❌ Lo siento, el menú no está disponible en este momento.";
    }

    let menuText = `🔥 **Menú de ${empresa.nombre}** 🐂\n\n`;
    menuText += `🌟 **Platillos:**\n`;
    empresa.menu.platillos.forEach(platillo => menuText += `• ${platillo.nombre} - $${platillo.precio}\n`);

    // Agregar bebidas solo si existen
    if (empresa.menu.bebidas && empresa.menu.bebidas.length > 0) {
        menuText += `\n🍹 **Bebidas:**\n`;
        empresa.menu.bebidas.forEach(bebida => menuText += `• ${bebida.nombre} - $${bebida.precio}\n`);
    }

    menuText += `\n💡 ¡Te esperamos en ${empresa.nombre}! 🔥`;
    return menuText;
}

client.initialize();
app.listen(port, () => console.log(`🚀 Servidor corriendo en http://localhost:${port}`));