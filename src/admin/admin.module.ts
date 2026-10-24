import { Module } from '@nestjs/common';
import { ApiController, PluginApiController } from './api.controller.js';
import { AdminApiController } from './admin-api.controller.js';
import { AuthApiController } from './auth-api.controller.js';
import { ConnectionsApiController } from './connections-api.controller.js';
import { ToolsApiController } from './tools-api.controller.js';
import { AppearanceApiController } from './appearance-api.controller.js';
import { NavLayoutController } from './nav-layout.controller.js';
import { LanguageController } from './language.controller.js';
import { PluginStoreController } from './plugin-store.controller.js';
import { TutorialsController } from './tutorials.controller.js';
import { LocalApiController } from './local-api.controller.js';
import { PublicApiController } from './public-api.controller.js';
import { SimulateController } from './simulate.controller.js';
import { AiApiController } from './ai-api.controller.js';
import { OpenPlatformController } from './open-platform.controller.js';
import { ProxyApiController } from './proxy-api.controller.js';
import { ProxyRegistryController } from './proxy-registry.controller.js';

@Module({
  controllers: [
    ApiController,
    PluginApiController,
    AdminApiController,
    AuthApiController,
    ConnectionsApiController,
    ToolsApiController,
    AppearanceApiController,
    NavLayoutController,
    LanguageController,
    PluginStoreController,
    TutorialsController,
    LocalApiController,
    PublicApiController,
    SimulateController,
    AiApiController,
    OpenPlatformController,
    ProxyRegistryController,
    ProxyApiController,
  ],
})
export class AdminModule {}
