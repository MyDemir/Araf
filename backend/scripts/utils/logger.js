"use strict";

const { createLogger, format, transports } = require("winston");
const path = require("path");

// [TR] Log dosyasının konumu: Proje kök dizini
// [EN] Log file location: Project root directory
const logFilePath = path.join(__dirname, "../../araf_full_stack.log.txt");

const logger = createLogger({
  // Üretim modunda 'info', test/dev modunda 'debug' seviyesinde çalışır
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }), // Hata yığınlarını (stack trace) yakalar
    format.json(), // Dosyada yapılandırılmış veri tutar
    format.printf(({ timestamp, level, message, stack, ...meta }) => {
      // .txt dosyasında okunabilir format
      const metaString = Object.keys(meta).length ? JSON.stringify(meta) : "";
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaString} ${stack ? `\n${stack}` : ""}`;
    })
  ),
  
  transports: [
    // 1. Terminale Renkli Çıktı Verir
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      ),
    }),
    
    // 2. Tüm Detayları .txt Dosyasına Kaydeder (Yerel Test Analizi İçin)
    new transports.File({ 
      filename: logFilePath,
      level: "debug", // En ince detaya kadar (kontrat eventleri dahil) kaydeder
      maxsize: 26214400, // 25MB dolunca yeni dosyaya geçer (dosya şişmesini önler)
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
