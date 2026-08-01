# Caption fonts

Four families ship with fableclip so a rendered clip looks the same on your Mac as it does
in the container. libass is handed this directory directly (`fontsdir`) rather than
asking fontconfig, because "whatever the host substituted for Arial" is not a caption
style.

All four are licensed under the **SIL Open Font License 1.1**, which permits bundling,
modification and redistribution — including inside a commercial product — provided the
fonts are not sold on their own and the copyright notice travels with them.

| File | Family | Copyright |
|:--|:--|:--|
| `Anton-Regular.ttf` | Anton | Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git) |
| `Poppins-ExtraBold.ttf` | Poppins | Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) |
| `LilitaOne-Regular.ttf` | Lilita One | Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz) |
| `BebasNeue-Regular.ttf` | Bebas Neue | Copyright © 2010 by Dharma Type |

Full licence text: <https://openfontlicense.org/open-font-license-official-text/>

Nothing here is fetched at runtime. No font is downloaded, and no request leaves the
machine to render a caption.
