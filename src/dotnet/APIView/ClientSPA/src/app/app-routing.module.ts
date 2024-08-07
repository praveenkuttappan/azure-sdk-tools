import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { IndexPageComponent } from './_components/index-page/index-page.component';
import { AuthGuard } from './_guards/auth.guard';
import { FeaturesGuard } from './_guards/features.guard';

const routes: Routes = [
  { path: '', component: IndexPageComponent, canActivate: [AuthGuard, FeaturesGuard] },
  { path: '',
     runGuardsAndResolvers: 'always',
     canActivate: [AuthGuard],
     children: [
      { path: 'review/:reviewId', loadChildren: () => import('./_modules/review-page/review-page.module').then(m => m.ReviewPageModule) }, // Lazy load review page module
     ]
  },
  { path: '**', component: IndexPageComponent, pathMatch: 'full' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
