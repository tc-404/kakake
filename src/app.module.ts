import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';

@Module({
  imports: [AdminModule],
})
export class AppModule {}
