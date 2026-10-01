import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildCorsOptions } from './common/cors';
import { requestContextMiddleware } from './common/request-context/request-context';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // First, so every later layer (guards, services, audit writes) sees the
  // request id, client address and user agent (Phase 15B).
  app.use(requestContextMiddleware);

  // Explicit origin allowlist (Phase 15B; was any origin) — see common/cors.ts.
  app.enableCors(buildCorsOptions());

  const config = new DocumentBuilder()
    .setTitle('My Andijan API')
    .setDescription('Backend API for the My Andijan platform')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`My Andijan API running on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`Swagger docs at http://localhost:${port}/docs`);
}
bootstrap();
