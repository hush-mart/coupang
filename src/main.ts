import * as process from 'node:process';

import { setupGlobalConsoleLogging } from '@daechanjo/log';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as dotenv from 'dotenv';
import { initializeTransactionalContext } from 'typeorm-transactional';

import { AppModule } from './app.module';
import { AppConfig } from './config/app.config';

const isDev = process.env.NODE_ENV !== 'PROD';
if (isDev) {
  dotenv.config({
    path: '/Users/daechanjo/codes/project/auto-store/.env',
  });
} else {
  dotenv.config({ path: '/app/.env' });
}

async function bootstrap() {
  const appConfig = AppConfig.getInstance();
  appConfig.appName = 'Coupang';
  initializeTransactionalContext();
  setupGlobalConsoleLogging({ appName: appConfig.appName });

  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [String(process.env.RABBITMQ_URL)],
      queue: 'coupang-queue',
      queueOptions: { durable: false },
    },
  });

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      validateCustomDecorators: false,
      skipMissingProperties: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix('/api');
  const server = app.getHttpAdapter().getInstance();

  server.get('/health', (req: any, res: any) => {
    res.status(200).send('OK');
  });

  await app.startAllMicroservices();
  await app.listen(9003, '0.0.0.0');
  console.log('쿠팡 서비스 시작');
}

bootstrap();
