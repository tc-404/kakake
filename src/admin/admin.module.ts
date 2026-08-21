import { Module } from '@nestjs/common';
import { ApiController, PluginApiController } from './api.controller.js';
import { AdminApiController } from './admin-api.controller.js';
import { PluginStoreController } from './plugin-store.controller.js';
import { TutorialsController } from './tutorials.controller.js';

@Module({
  controllers: [
    ApiController,
    PluginApiController,
    AdminApiController,
    PluginStoreController,
    TutorialsController,
  ],
})
export class AdminModule {}
