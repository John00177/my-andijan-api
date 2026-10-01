import { Module } from '@nestjs/common';
import { BusinessMenuController, MenuItemController, OwnerMenuController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [BusinessMenuController, OwnerMenuController, MenuItemController],
  providers: [ProductsService],
})
export class ProductsModule {}
