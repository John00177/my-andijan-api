import { Module } from '@nestjs/common';
import { BusinessMenuController, MenuItemController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [BusinessMenuController, MenuItemController],
  providers: [ProductsService],
})
export class ProductsModule {}
