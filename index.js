const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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
const client = new Client({
    authStrategy: new LocalAuth(),
});

// Crear cliente de Wit.ai
const witClient = new Wit({
    accessToken: process.env.WIT_ACCESS_TOKEN,
});

// Variable para controlar el estado del bot
let botActive = true;
let lastOrderTime = null;

// Mapa para rastrear el último periodo de saludo por usuario y si es su primer mensaje
const ultimoSaludoPeriodo = new Map();
const primerMensaje = new Map();
const intentosNoEntiendo = new Map(); // Mapa para contar los intentos fallidos

// Generar QR para vincular WhatsApp
client.on('qr', qr => {
    console.log('Escanea este código QR en WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🤖 ¡Bot de WhatsApp está listo!');
});

// Función para obtener el período actual del día
function getPeriodoDia() {
    const hora = new Date().getHours();
    if (hora >= 6 && hora < 12) return 'mañana';
    if (hora >= 12 && hora < 19) return 'tarde';
    return 'noche';
}

// Función para obtener saludo según la hora
function getSaludo() {
    const hora = new Date().getHours();
    if (hora >= 6 && hora < 12) return "☀️ ¡Buenos días! Bienvenido a Brasas del Toro 🐂";
    if (hora >= 12 && hora < 19) return "🌤️ ¡Buenas tardes! Bienvenido a Brasas del Toro 🐂";
    return "🌙 ¡Buenas noches! Bienvenido a Brasas del Toro 🐂";
}

// Escuchar mensajes
client.on('message', async message => {
    console.log(`📩 Mensaje recibido de ${message.from}: ${message.body}`);

    // Verificar si es el primer mensaje del usuario
    if (!primerMensaje.has(message.from)) {
        await client.sendMessage(message.from, getSaludo());
        primerMensaje.set(message.from, true);
        ultimoSaludoPeriodo.set(message.from, getPeriodoDia());
        return; // Terminar aquí para solo enviar el saludo
    }

    // Para mensajes posteriores, verificar si debe saludar por cambio de período
    const periodoActual = getPeriodoDia();
    const ultimoPeriodo = ultimoSaludoPeriodo.get(message.from);
    
    if (ultimoPeriodo !== periodoActual) {
        await client.sendMessage(message.from, getSaludo());
        ultimoSaludoPeriodo.set(message.from, periodoActual);
    }

    // Verificar si el bot está activo y si ha pasado el tiempo de pausa
    if (lastOrderTime && Date.now() - lastOrderTime < 5 * 60 * 1000) {
        // Bot en pausa, no hacer nada
        return;
    } else {
        botActive = true;
        lastOrderTime = null;
    }

    // Comprobar los intentos fallidos
    if (intentosNoEntiendo.has(message.from)) {
        if (intentosNoEntiendo.get(message.from) >= 3) {
            await client.sendMessage(message.from, '😕 Parece que estás teniendo problemas para comunicarte con el bot. Voy a ponerme en contacto con un miembro del personal para ayudarte. El bot estará inactivo por 15 minutos.');
            botActive = false; // Detener el bot por 15 minutos
            lastOrderTime = Date.now();
            return;
        }
    } else {
        intentosNoEntiendo.set(message.from, 0); // Inicializar contador para nuevo usuario
    }

    if (botActive) {
        // Simplificar la detección de platos en el mensaje
        const mensajeLower = message.body.toLowerCase();
        let pedidoEncontrado = false;

        // Buscar si alguna palabra del menú está en el mensaje
        for (const platillo of empresa.menu.platillos) {
            if (mensajeLower.includes(platillo.nombre.toLowerCase())) {
                pedidoEncontrado = true;
                break;
            }
        }

        if (!pedidoEncontrado) {
            for (const bebida of empresa.menu.bebidas) {
                if (mensajeLower.includes(bebida.nombre.toLowerCase())) {
                    pedidoEncontrado = true;
                    break;
                }
            }
        }

        if (pedidoEncontrado) {
            const respuesta = `🔥 **Pedido registrado en Brasas del Toro** 🐂\n\n📲 En breve, un agente se contactará contigo para confirmar tu pedido. ¡Gracias por elegirnos! 🙏`;
            
            // Enviar confirmación del pedido
            await client.sendMessage(message.from, respuesta);
            
            // Enviar métodos de pago
            const metodosPago = `💳 Aceptamos los siguientes métodos de pago:\n${empresa.pago}\n\n`;

            // Generar código QR para pago
            const qrUrl = `https://www.example.com/pago/${message.from}`;  // Reemplaza con tu URL de pago real
            const qrCode = await qrcode.toDataURL(qrUrl);

            // Enviar QR y mensaje
            await client.sendMessage(message.from, `${metodosPago}📸 Escanea el siguiente código QR para realizar el pago:`);
            await client.sendMessage(message.from, qrCode);
            await client.sendMessage(message.from, `⚠️ **¡No olvides mandarme el comprobante de pago!**`);

            // Desactivar el bot por 5 minutos
            botActive = false;
            lastOrderTime = Date.now();
            
            console.log(`🤖 Bot pausado por 5 minutos para el número ${message.from}`);
            return;
        }

        // Si no hay pedido, procesar el mensaje normalmente
        try {
            const response = await witClient.message(message.body);
            const intent = response.intents.length > 0 ? response.intents[0].name : null;
            
            let reply = '❌ Lo siento, no entendí bien tu mensaje.';

            // Si hay un intento fallido
            if (reply === '❌ Lo siento, no entendí bien tu mensaje.') {
                let intentos = intentosNoEntiendo.get(message.from);
                intentosNoEntiendo.set(message.from, intentos + 1);
            }

            if (intent === 'consulta_menu') {
                reply = formatMenu(empresa);
            } else if (intent === 'consulta_horario') {
                reply = `⏰ Nuestro horario de atención es: ${empresa.horario}`;
            } else if (intent === 'consulta_contacto') {
                reply = `📱 Puedes contactarnos en: ${empresa.contacto}`;
            } else if (intent === 'consulta_ubicacion') {
                reply = `📍 Estamos ubicados en: ${empresa.ubicacion}`;
            } else if (intent === 'consulta_pago') {
                reply = `💳 Aceptamos los siguientes métodos de pago: ${empresa.pago}`;
            } else if (intent === 'consulta_pedido') {
                reply = `🍽️ ¿Qué te gustaría ordenar de nuestra carta?`;
            } else if (intent === 'pedido_echo') {
                reply = `✅ Tu pedido ha sido registrado. Te enviaremos una confirmación en breve.`;
            } else if (intent === 'consulta_saludo') {
                reply = `🐂 Somos Brasas del Toro, ¿en qué podemos ayudarte? 😊`;
            } else if (intent === 'consulta_despedida') {
                reply = `👋 ¡Hasta luego! Esperamos verte pronto en Brasas del Toro 🐂`;
            }

            await client.sendMessage(message.from, reply);
        } catch (error) {
            console.error('❌ Error:', error);
            await client.sendMessage(message.from, '❌ Lo siento, no entendí bien tu mensaje.');
        }
    }

    // Verificar si el bot está detenido por 15 minutos
    if (!botActive && Date.now() - lastOrderTime > 15 * 60 * 1000) {
        botActive = true; // Reactivar el bot después de 15 minutos
        console.log(`🤖 El bot está activo nuevamente para el número ${message.from}`);
    }
});

// Función para formatear el menú
function formatMenu(empresa) {
    let menuText = `🔥 **Menú de Brasas del Toro** 🐂\n\n🌟 **Especialidad:** ${empresa.menu.especialidad}\n\n🍖 **Nuestros Platillos:**\n`;

    empresa.menu.platillos.forEach(platillo => {
        menuText += `• ${platillo.nombre} - $${platillo.precio}\n`;
    });

    menuText += `\n🥤 **Bebidas:**\n`;

    empresa.menu.bebidas.forEach(bebida => {
        menuText += `• ${bebida.nombre} - $${bebida.precio}\n`;
    });

    menuText += `\n💡 ¡Te esperamos en Brasas del Toro para disfrutar de la mejor carne a la parrilla! 🔥`;
    return menuText;
}

client.initialize();

// Servidor Express
app.listen(port, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
