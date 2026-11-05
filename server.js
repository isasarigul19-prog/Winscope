import express from "express";
import pg from "pg";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "500kb" }));
// WinScope arayüzü bu dosyaya gömülüdür; dağıtım için public/index.html gerekmez.
const EMBEDDED_INDEX_HTML = Buffer.from("PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0idHIiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij48bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSI+PHRpdGxlPldpblNjb3BlIExpdmU8L3RpdGxlPjxzdHlsZT4KOnJvb3R7LS1iZzojMDQxOTFlOy0tcDojMDgyNzJkOy0tcDI6IzBjMzQzYjstLWxpbmU6IzE1NTA1YTstLXQ6I2YxZmJmYzstLW06IzliYjliZjstLXBpbms6I2ZmMmY2MzstLWdyZWVuOiM0MmU2YTA7LS1hbWJlcjojZmZkMDRhOy0tZ3JheTojN2Y5ZGEzfSp7Ym94LXNpemluZzpib3JkZXItYm94fWJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTU1ZGVnLCMwMzE0MTksIzA3MzAzOCA2NSUsIzA0MTkxZSk7Y29sb3I6dmFyKC0tdCk7Zm9udDoxNHB4IHN5c3RlbS11aSxzYW5zLXNlcmlmfWhlYWRlcntwYWRkaW5nOjE2cHg7bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSl9LmxvZ297Zm9udC13ZWlnaHQ6OTUwO2xldHRlci1zcGFjaW5nOi4wOGVtO2ZvbnQtc2l6ZToyNXB4fS5sb2dvIHNwYW57Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tcGluayk7bWFyZ2luLWxlZnQ6NHB4O2ZvbnQtd2VpZ2h0OjcwMH0uc21hbGwsLnN1Yntjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjQ1fW1haW57bWF4LXdpZHRoOjEwNTBweDttYXJnaW46YXV0bztwYWRkaW5nOjEycHh9LnRvb2xiYXIsLmFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZsZXgtd3JhcDp3cmFwO21hcmdpbjoxMHB4IDB9YnV0dG9uLHNlbGVjdCxpbnB1dHtmb250OmluaGVyaXQ7Y29sb3I6dmFyKC0tdCk7YmFja2dyb3VuZDp2YXIoLS1wMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjExcHg7cGFkZGluZzoxMHB4IDEycHh9YnV0dG9ue2N1cnNvcjpwb2ludGVyfS5wcmltYXJ5LC5hY3RpdmV7YmFja2dyb3VuZDp2YXIoLS1waW5rKTtib3JkZXItY29sb3I6dmFyKC0tcGluayk7Zm9udC13ZWlnaHQ6ODAwfS5wYW5lbCwuY2FyZHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNDVkZWcsdmFyKC0tcCksIzA2MjEyNik7cGFkZGluZzoxM3B4O21hcmdpbjoxMnB4IDB9LmhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2NvbG9yOnZhcigtLW0pO2ZvbnQtc2l6ZToxMnB4fS50ZWFtc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvIDFmcjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW46MTdweCAwfS50ZWFte2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTdweDtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS50ZWFtOmxhc3QtY2hpbGR7dGV4dC1hbGlnbjpyaWdodH0uc2NvcmV7Zm9udC13ZWlnaHQ6OTUwO2ZvbnQtc2l6ZToyNnB4O3doaXRlLXNwYWNlOm5vd3JhcH0ubWV0YXt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0udGFic3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnI7Z2FwOjRweDtiYWNrZ3JvdW5kOiMwNjIxMjY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzozcHg7bWFyZ2luOjEycHggMH0udGFicyBidXR0b257Ym9yZGVyOjA7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0udGFicyBidXR0b24uYWN0aXZle2JhY2tncm91bmQ6dmFyKC0tcGluayl9LmdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnIgMWZyO2dhcDoxMHB4fS50YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1zcGFjaW5nOjAgNXB4fS50YWJsZSB0ZHtiYWNrZ3JvdW5kOiMwNjI0MmE7cGFkZGluZzoxMHB4O2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpfS50YWJsZSB0ZDpmaXJzdC1jaGlsZHtib3JkZXItbGVmdDoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHggMCAwIDlweDtjb2xvcjp2YXIoLS1tKX0udGFibGUgdGQ6bGFzdC1jaGlsZHtib3JkZXItcmlnaHQ6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MCA5cHggOXB4IDA7Zm9udC13ZWlnaHQ6ODAwfS5ncm91cHtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjhweH0uZ3R7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6ODUwO21hcmdpbjo0cHggM3B4IDhweH0uYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6NzVweCAxZnIgNDBweDtnYXA6N3B4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTJweDtwYWRkaW5nOjVweCAwfS50cmFja3toZWlnaHQ6MTFweDtib3JkZXItcmFkaXVzOjIwcHg7YmFja2dyb3VuZDojMTkzZDQ0O292ZXJmbG93OmhpZGRlbn0uZmlsbHtoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKTtib3JkZXItcmFkaXVzOjIwcHh9LmZpbGwuYW1iZXJ7YmFja2dyb3VuZDp2YXIoLS1hbWJlcil9LmZpbGwuZ3JheXtiYWNrZ3JvdW5kOnZhcigtLWdyYXkpfS5vZGRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSk7Z2FwOjdweH0ub2Rke2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojMGEzMDM3O2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjlweDt0ZXh0LWFsaWduOmNlbnRlcjtvdmVyZmxvdy13cmFwOmFueXdoZXJlfS5vZGQgbGFiZWx7ZGlzcGxheTpibG9jaztjb2xvcjp2YXIoLS1tKTtmb250LXNpemU6MTFweH0ub2RkIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxOHB4fS5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uZW1wdHl7cGFkZGluZzoxOHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW0pfS5lcnJ7Y29sb3I6I2ZmOWJhYX0uc3RhdHRlYW17cGFkZGluZzoxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O21hcmdpbjo4cHggMH0uc3RhdGxpbmV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6NXB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgIzEyM2E0MX1AbWVkaWEobWF4LXdpZHRoOjY1MHB4KXsuZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS5vZGRze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMixtaW5tYXgoMCwxZnIpKX0udGVhbXtmb250LXNpemU6MTRweH0uc2NvcmV7Zm9udC1zaXplOjIzcHh9fQojbWF0Y2hTZWFyY2h7ZmxleDowIDEgMjIwcHghaW1wb3J0YW50O21pbi13aWR0aDoxMjBweCFpbXBvcnRhbnQ7bWF4LXdpZHRoOjI2MHB4fSNzZWFyY2hNYXRjaCwjY2xlYXJNYXRjaFNlYXJjaHtwYWRkaW5nOjhweCAxMHB4O2ZvbnQtc2l6ZToxMnB4fUBtZWRpYShtYXgtd2lkdGg6NjUwcHgpeyNtYXRjaFNlYXJjaFBhbmVsIC50b29sYmFye2dhcDo2cHh9I21hdGNoU2VhcmNoe21heC13aWR0aDpub25lO2ZsZXg6MSAxIDE1MHB4IWltcG9ydGFudH19Ci5oaWRkZW57ZGlzcGxheTpub25lIWltcG9ydGFudH0uYXJjaGl2ZS1saXN0e2Rpc3BsYXk6Z3JpZDtnYXA6OXB4fS5hcmNoaXZlLWl0ZW17Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxMXB4O2JhY2tncm91bmQ6IzA2MjQyYX0uYXJjaGl2ZS1pdGVtIC50aXRsZXtmb250LXdlaWdodDo4NTA7bWFyZ2luLWJvdHRvbTo3cHh9LmFyY2hpdmUtaXRlbSAucm93bGluZXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjhweDtwYWRkaW5nOjRweCAwfS5hcmNoaXZlLWl0ZW0gLnJvd2xpbmUgc3Bhbntjb2xvcjp2YXIoLS1tKX0uYXJjaGl2ZS1hY3Rpb25ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O21hcmdpbi10b3A6OXB4O2ZsZXgtd3JhcDp3cmFwfS5hcmNoaXZlLWFjdGlvbnMgYnV0dG9ue3BhZGRpbmc6N3B4IDEwcHh9PC9zdHlsZT48L2hlYWQ+PGJvZHk+PGhlYWRlcj48ZGl2PjxkaXYgY2xhc3M9ImxvZ28iPldJTlNDT1BFIDxzcGFuPkxJVkU8L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0ic3ViIj5DYW5sxLEgZnV0Ym9sIGFuYWxpeiB2ZSBhbGFybSBzaXN0ZW1pPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiIGlkPSJjb25uIj5CQcSeTEFOSVlPUjwvZGl2PjwvaGVhZGVyPjxtYWluPjxkaXYgY2xhc3M9InRvb2xiYXIiPjxidXR0b24gY2xhc3M9InByaW1hcnkiIGlkPSJyZWZyZXNoIj7ihrsgQ2FubMSxIG1hw6dsYXI8L2J1dHRvbj48aW5wdXQgaWQ9ImRhdGUiIHR5cGU9ImRhdGUiPjxidXR0b24gaWQ9ImJ1bGxldGluIj5Cw7xsdGVuPC9idXR0b24+PGJ1dHRvbiBpZD0ic2hvd0FuYWx5c2VzIj5Hw7xuw7xuIEFuYWxpemxlcmk8L2J1dHRvbj48YnV0dG9uIGlkPSJzaG93Q291cG9ucyI+R8O8bsO8biBLdXBvbmxhcsSxPC9idXR0b24+PHNlbGVjdCBpZD0iZmlsdGVyIj48b3B0aW9uIHZhbHVlPSJhbGwiPlTDvG0gbWHDp2xhcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImxpdmUiPkNhbmzEsTwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9Im1hdGNoU2VhcmNoUGFuZWwiPjxoMyBzdHlsZT0ibWFyZ2luOjJweCAwIDhweCI+8J+UjiAx4oCZZSAxIE1Bw4cgQVJBPC9oMz48ZGl2IGNsYXNzPSJ0b29sYmFyIiBzdHlsZT0ibWFyZ2luOjAiPjxpbnB1dCBpZD0ibWF0Y2hTZWFyY2giIHR5cGU9InNlYXJjaCIgcGxhY2Vob2xkZXI9IlRha8SxbSBhZMSxOiBGZW5lcmJhaMOnZSwgQmFyY2Vsb25h4oCmIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxODBweCI+PGJ1dHRvbiBpZD0ic2VhcmNoTWF0Y2giIGNsYXNzPSJwcmltYXJ5Ij5NYcOnIEFyYTwvYnV0dG9uPjxidXR0b24gaWQ9ImNsZWFyTWF0Y2hTZWFyY2giPlRlbWl6bGU8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJtYXRjaFNlYXJjaFJlc3VsdCIgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkFyYW1hayBpw6dpbiB0YWvEsW0gYWTEsW7EsSB5YXouPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCIgaWQ9ImNvdXBvblBhbmVsIj48aDMgc3R5bGU9Im1hcmdpbjoycHggMCAxMHB4Ij7wn46vIFdJTlNDT1BFIEtVUE9OTEFSSTwvaDM+PGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXAiPjxidXR0b24gaWQ9Im1ha2VDb3Vwb24iIGNsYXNzPSJwcmltYXJ5Ij7imr0gTWHDpyDDlm7DvCBLdXBvbnUgKEVuIGF6IDIgbWHDpyk8L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlU3VycHJpc2VDb3Vwb24iPvCfjrIgMTAgTWHDp2zEsWsgS3Vwb248L2J1dHRvbj48YnV0dG9uIGlkPSJtYWtlTGl2ZUJlc3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM0MmU2YTA7Y29sb3I6IzA0MTkxZTtmb250LXdlaWdodDo5MDA7Ym9yZGVyOm5vbmUiPuKaoSBDYW5sxLEgRW4gR8O8dmVuaWxpciBUZWsgVGVyY2loPC9idXR0b24+PC9kaXY+PGRpdiBpZD0iY291cG9uUmVzdWx0IiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjwvZGl2Pjwvc2VjdGlvbj48c2VjdGlvbiBjbGFzcz0icGFuZWwgaGlkZGVuIiBpZD0iYW5hbHlzZXNBcmNoaXZlIj48ZGl2IGNsYXNzPSJoZWFkIj48aDM+8J+TiyBHw7xuw7xuIEFuYWxpemxlcmk8L2gzPjxidXR0b24gb25jbGljaz0iY2xvc2VBcmNoaXZlcygpIj5LYXBhdDwvYnV0dG9uPjwvZGl2PjxkaXYgaWQ9ImFuYWx5c2VzQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxzZWN0aW9uIGNsYXNzPSJwYW5lbCBoaWRkZW4iIGlkPSJjb3Vwb25zQXJjaGl2ZSI+PGRpdiBjbGFzcz0iaGVhZCI+PGgzPvCfjp/vuI8gR8O8bsO8biBLdXBvbmxhcsSxPC9oMz48YnV0dG9uIG9uY2xpY2s9ImNsb3NlQXJjaGl2ZXMoKSI+S2FwYXQ8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJjb3Vwb25zQXJjaGl2ZUxpc3QiIGNsYXNzPSJhcmNoaXZlLWxpc3QiPlnDvGtsZW5peW9y4oCmPC9kaXY+PC9zZWN0aW9uPjxkaXYgaWQ9Im1zZyIgY2xhc3M9InNtYWxsIj48L2Rpdj48c2VjdGlvbiBpZD0ibWF0Y2hlcyI+PGRpdiBjbGFzcz0iZW1wdHkiPk1hw6dsYXIgecO8a2xlbml5b3LigKY8L2Rpdj48L3NlY3Rpb24+PC9tYWluPjxzY3JpcHQ+CmNvbnN0ICQ9eD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoeCk7bGV0IG1hdGNoZXM9W10sYnVsbGV0aW5NYXRjaGVzPVtdO2NvbnN0IGVzYz14PT5TdHJpbmcoeD8/JycpLnJlcGxhY2UoL1smPD4iJ10vZyxjPT4oeycmJzonJmFtcDsnLCc8JzonJmx0OycsJz4nOicmZ3Q7JywnIic6JyZxdW90OycsIiciOicmIzM5Oyd9W2NdKSk7ZnVuY3Rpb24gYmFyKGxhYmVsLHYsY2xzPScnKXtpZih2PT1udWxsfHwhTnVtYmVyLmlzRmluaXRlKE51bWJlcih2KSkpcmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjwvZGl2PjxiPuKAlDwvYj48L2Rpdj5gO3Y9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTnVtYmVyKHYpKSk7cmV0dXJuIGA8ZGl2IGNsYXNzPSJiYXIiPjxzcGFuPiR7ZXNjKGxhYmVsKX08L3NwYW4+PGRpdiBjbGFzcz0idHJhY2siPjxkaXYgY2xhc3M9ImZpbGwgJHtjbHN9IiBzdHlsZT0id2lkdGg6JHt2fSUiPjwvZGl2PjwvZGl2PjxiPiR7di50b0ZpeGVkKDEpfSU8L2I+PC9kaXY+YH0KZnVuY3Rpb24gY2FyZChtKXtyZXR1cm4gYDxhcnRpY2xlIGNsYXNzPSJjYXJkIiBpZD0ibSR7TnVtYmVyKG0uaWQpfSI+PGRpdiBjbGFzcz0iaGVhZCI+PHNwYW4+JHtlc2MobS5jb3VudHJ5fHwnJyl9IMK3ICR7ZXNjKG0ubGVhZ3VlfHwnJyl9PC9zcGFuPjxzcGFuPiR7ZXNjKG0uc3RhdHVzPT09J05TJz8nQkHFnkxBTUFESSc6KG0uc3RhdHVzPT09J0ZUJz8nTUHDhyBCxLBUVMSwJzptLnN0YXR1c3x8JycpKX0ke20ubWludXRlIT1udWxsJiYhWydOUycsJ0ZUJ10uaW5jbHVkZXMobS5zdGF0dXMpPycgwrcgJytlc2MobS5taW51dGUpKyInIjonJ308L3NwYW4+PC9kaXY+PGRpdiBjbGFzcz0idGVhbXMiPjxkaXYgY2xhc3M9InRlYW0iPiR7ZXNjKG0uaG9tZSl9PC9kaXY+PGRpdiBjbGFzcz0ic2NvcmUiPiR7ZXNjKG0uaG9tZVNjb3JlPz8n4oCTJyl9IDogJHtlc2MobS5hd2F5U2NvcmU/PyfigJMnKX08L2Rpdj48ZGl2IGNsYXNzPSJ0ZWFtIj4ke2VzYyhtLmF3YXkpfTwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9Im1ldGEiPiR7bS5maXh0dXJlRGF0ZT9uZXcgRGF0ZShtLmZpeHR1cmVEYXRlKS50b0xvY2FsZVN0cmluZygndHItVFInKTonJ308L2Rpdj48ZGl2IGNsYXNzPSJ0YWJzIj48YnV0dG9uIGNsYXNzPSJhY3RpdmUiIG9uY2xpY2s9ImFuYWx5emUoJHtOdW1iZXIobS5pZCl9LCcke20uc3RhdHVzPT09J05TJz8ncHJlbWF0Y2gnOidsaXZlJ30nKSI+TUHDhyBBTkFMxLBaxLA8L2J1dHRvbj48YnV0dG9uIG9uY2xpY2s9InN0YXRzKCR7TnVtYmVyKG0uaWQpfSkiPsSwU1RBVMSwU1TEsEs8L2J1dHRvbj48L2Rpdj48ZGl2IGlkPSJhJHtOdW1iZXIobS5pZCl9Ij48ZGl2IGNsYXNzPSJlbXB0eSI+TWHDpyBhbmFsaXppIGnDp2luIGRva3VuLjwvZGl2PjwvZGl2PjxkaXYgaWQ9InMke051bWJlcihtLmlkKX0iIGNsYXNzPSJoaWRkZW4iPjwvZGl2PjwvYXJ0aWNsZT5gfWZ1bmN0aW9uIHJlbmRlcigpe2xldCBhPSQoJ2ZpbHRlcicpLnZhbHVlPT09J2xpdmUnP21hdGNoZXMuZmlsdGVyKG09PiFbJ0ZUJywnQUVUJywnUEVOJywnTlMnXS5pbmNsdWRlcyhtLnN0YXR1cykpOm1hdGNoZXM7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1hLmxlbmd0aD9hLm1hcChjYXJkKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkJ1IGxpc3RlZGUgbWHDpyBidWx1bmFtYWTEsS48L2Rpdj4nfWFzeW5jIGZ1bmN0aW9uIGxpdmUoKXsgJCgnbWF0Y2hlcycpLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZW1wdHkiPkNhbmzEsSBtYcOnbGFyIHnDvGtsZW5peW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvbGl2ZScpLGo9YXdhaXQgci5qc29uKCk7aWYoIXIub2spdGhyb3cgRXJyb3Ioai5kZXRhaWx8fGouZXJyb3IpO21hdGNoZXM9ai5tYXRjaGVzfHxbXTskKCdjb25uJykudGV4dENvbnRlbnQ9J1NVTlVDVSBCQcSeTEknOyQoJ21zZycpLnRleHRDb250ZW50PWAke21hdGNoZXMubGVuZ3RofSBtYcOnIMK3ICR7bmV3IERhdGUoai5mZXRjaGVkQXR8fERhdGUubm93KCkpLnRvTG9jYWxlVGltZVN0cmluZygndHItVFInKX1gO3JlbmRlcigpfWNhdGNoKGUpeyQoJ2Nvbm4nKS50ZXh0Q29udGVudD0nSEFUQSc7JCgnbXNnJykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gOyQoJ21hdGNoZXMnKS5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnbGFyIGFsxLFuYW1hZMSxLjwvZGl2Pid9fWFzeW5jIGZ1bmN0aW9uIGJ1bGxldGluKCl7bGV0IGQ9JCgnZGF0ZScpLnZhbHVlO2lmKCFkKXJldHVybjt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvZml4dHVyZXM/ZGF0ZT0nK2VuY29kZVVSSUNvbXBvbmVudChkKSksaj1hd2FpdCByLmpzb24oKTtpZighci5vayl0aHJvdyBFcnJvcihqLmRldGFpbHx8ai5lcnJvcik7YnVsbGV0aW5NYXRjaGVzPWoubWF0Y2hlc3x8W107JCgnbWF0Y2hlcycpLmlubmVySFRNTD1idWxsZXRpbk1hdGNoZXMubGVuZ3RoP2J1bGxldGluTWF0Y2hlcy5tYXAoY2FyZCkuam9pbignJyk6JzxkaXYgY2xhc3M9ImVtcHR5Ij5NYcOnIGJ1bHVuYW1hZMSxLjwvZGl2Pic7JCgnbXNnJykudGV4dENvbnRlbnQ9YCR7YnVsbGV0aW5NYXRjaGVzLmxlbmd0aH0gbWHDpyDCtyAke2R9YH1jYXRjaChlKXskKCdtc2cnKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJlcnIiPiR7ZXNjKGUubWVzc2FnZSl9PC9zcGFuPmB9fWFzeW5jIGZ1bmN0aW9uIHNlYXJjaE1hdGNoKCl7Y29uc3QgcT0kKCdtYXRjaFNlYXJjaCcpLnZhbHVlLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKTtjb25zdCBvdXQ9JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKTtpZighcSl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgYmlyIHRha8SxbSBhZMSxIHlheiBrcmFsLjwvc3Bhbj4nO3JldHVybn1jb25zdCBkPSQoJ2RhdGUnKS52YWx1ZTtpZighZCl7b3V0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImVyciI+w5ZuY2UgdGFyaWggc2XDpy48L3NwYW4+JztyZXR1cm59b3V0LnRleHRDb250ZW50PSdCw7xsdGVuZGVraSBtYcOnbGFyIGFyYW7EsXlvcuKApic7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD10cnVlO3RyeXtsZXQgc291cmNlPWJ1bGxldGluTWF0Y2hlcztpZighc291cmNlLmxlbmd0aHx8IXNvdXJjZS5zb21lKG09PlN0cmluZyhtLmZpeHR1cmVEYXRlfHwnJykuc2xpY2UoMCwxMCk9PT1kKSl7Y29uc3Qgcj1hd2FpdCBmZXRjaCgnL2FwaS9maXh0dXJlcz9kYXRlPScrZW5jb2RlVVJJQ29tcG9uZW50KGQpLHtzaWduYWw6QWJvcnRTaWduYWwudGltZW91dCgyMDAwMCl9KTtjb25zdCBqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yfHwnQsO8bHRlbiBhbMSxbmFtYWTEsScpO3NvdXJjZT1qLm1hdGNoZXN8fFtdO2J1bGxldGluTWF0Y2hlcz1zb3VyY2V9Y29uc3QgZm91bmQ9c291cmNlLmZpbHRlcihtPT5gJHttLmhvbWV8fCcnfSAke20uYXdheXx8Jyd9YC50b0xvY2FsZUxvd2VyQ2FzZSgndHItVFInKS5pbmNsdWRlcyhxKSk7aWYoIWZvdW5kLmxlbmd0aCl7b3V0LnRleHRDb250ZW50PWDigJwkeyQoJ21hdGNoU2VhcmNoJykudmFsdWUudHJpbSgpfeKAnSBpw6dpbiAke2R9IGLDvGx0ZW5pbmRlIG1hw6cgYnVsdW5hbWFkxLEuYDtyZXR1cm59bWF0Y2hlcz1zb3VyY2U7JCgnZmlsdGVyJykudmFsdWU9J2FsbCc7JCgnbWF0Y2hlcycpLmlubmVySFRNTD1mb3VuZC5tYXAoY2FyZCkuam9pbignJyk7b3V0LnRleHRDb250ZW50PWAke2ZvdW5kLmxlbmd0aH0gZcWfbGXFn2VuIG1hw6cgYnVsdW5kdSDCtyAke2R9LiBBbmFsaXogdmV5YSBpc3RhdGlzdGlrIGnDp2luIG1hw6dhIGRva3VuLmA7JCgnbXNnJykudGV4dENvbnRlbnQ9YEFyYW1hIHNvbnVjdTogJHtmb3VuZC5sZW5ndGh9IG1hw6cgwrcgJHtkfWA7JCgnbWF0Y2hlcycpLnNjcm9sbEludG9WaWV3KHtiZWhhdmlvcjonc21vb3RoJyxibG9jazonc3RhcnQnfSl9Y2F0Y2goZSl7b3V0LmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+QXJhbWEgYmHFn2FyxLFzxLF6OiAke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7JCgnc2VhcmNoTWF0Y2gnKS5kaXNhYmxlZD1mYWxzZX19ZnVuY3Rpb24gY2xlYXJNYXRjaFNlYXJjaCgpeyQoJ21hdGNoU2VhcmNoJykudmFsdWU9Jyc7JCgnbWF0Y2hTZWFyY2hSZXN1bHQnKS50ZXh0Q29udGVudD0nQXJhbWFrIGnDp2luIHRha8SxbSBhZMSxbsSxIHlhei4nO2J1bGxldGluTWF0Y2hlcz1bXX0KYXN5bmMgZnVuY3Rpb24gYW5hbHl6ZShpZCxtb2RlKXtsZXQgYm94PSQoJ2EnK2lkKTtib3guaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJlbXB0eSI+QW5hbGl6IGVkaWxpeW9y4oCmPC9kaXY+Jzt0cnl7bGV0IHI9YXdhaXQgZmV0Y2goYC9hcGkvbWF0Y2gvJHtpZH0vYW5hbHl6ZT9tb2RlPSR7bW9kZX1gKSxqPWF3YWl0IHIuanNvbigpO2lmKCFyLm9rKXRocm93IEVycm9yKGouZGV0YWlsfHxqLmVycm9yKTtsZXQgcD1qLm1hcmtldFBlcmNlbnRhZ2VzfHx7fTtjb25zdCBwY3Q9KGtleSk9Pntjb25zdCB4PXBba2V5XTtyZXR1cm4geCYmeC5wZXJjZW50IT1udWxsJiZOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKHgucGVyY2VudCkpP2AlJHtlc2MoeC5wZXJjZW50KX0gPHNwYW4gY2xhc3M9InNtYWxsIj4oJHtlc2MoeC5zb3VyY2V8fCdLYXluYWsgYmVsaXJ0aWxtZWRpJyl9IMK3IHNvbiA1IG1hw6cgw7ZybmVrbGVtaTogJHtlc2MoeC5zYW1wbGVTaXplfHwwKX0pPC9zcGFuPmA6J1ZlcmkgeW9rJ307Ym94LmlubmVySFRNTD1gPGRpdiBjbGFzcz0iZ3JpZCI+PGRpdj48dGFibGUgY2xhc3M9InRhYmxlIj48dHI+PHRkPkFOQSBURVJDxLBIPC90ZD48dGQ+JHtlc2Moai5tYWluUGlja3x8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPkFMVEVSTkFUxLBGPC90ZD48dGQ+JHtlc2Moai5hbHRlcm5hdGl2ZXx8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPsSwWSBTS09SPC90ZD48dGQ+JHtlc2Moai5oYWxmVGltZVNjb3JlfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgU0tPUjwvdGQ+PHRkPiR7ZXNjKGouZnVsbFRpbWVTY29yZXx8J+KAlCcpfTwvdGQ+PC90cj48dHI+PHRkPkNBTkxJIFRFUkPEsEg8L3RkPjx0ZD4ke2VzYyhqLmxpdmVQaWNrfHwn4oCUJyl9PC90ZD48L3RyPjx0cj48dGQ+xLBZIDAuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ2h0MDUnKX08L3RkPjwvdHI+PHRyPjx0ZD7EsFkgMS41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnaHQxNScpfTwvdGQ+PC90cj48dHI+PHRkPkVWIDEuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ2hvbWUxNScpfTwvdGQ+PC90cj48dHI+PHRkPkRFUCAxLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdhd2F5MTUnKX08L3RkPjwvdHI+PHRyPjx0ZD5NUyAwLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdtczA1Jyl9PC90ZD48L3RyPjx0cj48dGQ+TVMgMS41IMOcU1Q8L3RkPjx0ZD4ke3BjdCgnbXMxNScpfTwvdGQ+PC90cj48dHI+PHRkPk1TIDIuNSDDnFNUPC90ZD48dGQ+JHtwY3QoJ21zMjUnKX08L3RkPjwvdHI+PHRyPjx0ZD5NUyAzLjUgw5xTVDwvdGQ+PHRkPiR7cGN0KCdtczM1Jyl9PC90ZD48L3RyPjx0cj48dGQ+S0cgVkFSPC90ZD48dGQ+JHtwY3QoJ2J0dHMnKX08L3RkPjwvdHI+PHRyPjx0ZD5Zw5xaREUgVkVSxLBTxLA8L3RkPjx0ZD5BUEktRm9vdGJhbGwgZ2Vyw6dlayB0YW1hbWxhbm3EscWfIG1hw6dsYXIuPC90ZD48L3RyPjwvdGFibGU+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+JHtlc2Moai5ub3RlfHwnQW5hbGl6IG5vdHUgeW9rLicpfTwvZGl2PjxkaXYgY2xhc3M9InRvb2xiYXIiPjxidXR0b24gY2xhc3M9InByaW1hcnkiIG9uY2xpY2s9ImFwcHJvdmVBbmFseXNpcygke2lkfSwnJHttb2RlfScpIj5BbmFsaXppIE9uYXlsYSB2ZSBLYXlkZXQ8L2J1dHRvbj48L2Rpdj5gfWNhdGNoKGUpe2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9InNtYWxsIGVyciI+JHtlc2MoZS5tZXNzYWdlKX08L2Rpdj5gfX0KYXN5bmMgZnVuY3Rpb24gc3RhdHMoaWQpe2xldCBiPSQoJ3MnK2lkKTtiLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO2IuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJlbXB0eSI+xLBzdGF0aXN0aWsgecO8a2xlbml5b3LigKY8L2Rpdj4nO3RyeXtsZXQgcj1hd2FpdCBmZXRjaChgL2FwaS9tYXRjaC8ke2lkfS9zdGF0c2ApLGo9YXdhaXQgci5qc29uKCk7aWYoIXIub2spdGhyb3cgRXJyb3Ioai5lcnJvcnx8J8Swc3RhdGlzdGlrIGFsxLFuYW1hZMSxJyk7bGV0IGxpc3Q9ai5zdGF0c3x8W107aWYoIWxpc3QubGVuZ3RoKXtiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0icGFuZWwiPsSwc3RhdGlzdGlrIHZlcmlzaSBidWx1bmFtYWTEsS48L2Rpdj4nO3JldHVybjt9Yi5pbm5lckhUTUw9YDxkaXYgY2xhc3M9InBhbmVsIj48aDM+xLBTVEFUxLBTVMSwSzwvaDM+JHtsaXN0Lm1hcCh0PT57bGV0IG5hbWU9dC50ZWFtPy5uYW1lfHx0LnRlYW18fCdUYWvEsW0nO2xldCBzdExpc3Q9QXJyYXkuaXNBcnJheSh0LnN0YXRpc3RpY3MpP3Quc3RhdGlzdGljczoodHlwZW9mIHQuc3RhdGlzdGljcz09PSdvYmplY3QnP09iamVjdC5lbnRyaWVzKHQuc3RhdGlzdGljcykubWFwKChbdHlwZSx2YWx1ZV0pPT4oe3R5cGUsdmFsdWV9KSk6W10pO3JldHVybiBgPGRpdiBjbGFzcz0ic3RhdHRlYW0iPjxiPiR7ZXNjKG5hbWUpfTwvYj4ke3N0TGlzdC5tYXAocz0+YDxkaXYgY2xhc3M9InN0YXRsaW5lIj48c3Bhbj4ke2VzYyhzLnR5cGV8fCcnKX08L3NwYW4+PGI+JHtlc2Mocy52YWx1ZT8/Jy0nKX08L2I+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+YH0pLmpvaW4oJycpfTwvZGl2PmB9Y2F0Y2goZSl7Yi5pbm5lckhUTUw9YDxkaXYgY2xhc3M9InNtYWxsIGVyciI+JHtlc2MoZS5tZXNzYWdlKX08L2Rpdj5gfX0KZnVuY3Rpb24gcmVuZGVyQ291cG9uKGQpe2NvbnN0IGJveD0kKCdjb3Vwb25SZXN1bHQnKTtpZihkLnN0YXR1cz09PSdFUlJPUid8fGQuZXJyb3Ipe2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+PGI+JHtlc2MoZC5lcnJvcnx8J0t1cG9uIG9sdcWfdHVydWxhbWFkxLEuJyl9PC9iPjxkaXY+JHtlc2MoZC5kZXRhaWx8fCcnKX08L2Rpdj48L2Rpdj5gO3JldHVybjt9aWYoZC5zdGF0dXM9PT0nTk9fTUFUQ0hFUyd8fCFkLnBpY2tzfHwhZC5waWNrcy5sZW5ndGgpe2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+PGI+JHtlc2MoZC5tZXNzYWdlfHwnWWV0ZXJsaSBzYXnEsWRhIGRvxJ9ydWxhbmFiaWxpciBvcmFubMSxIG1hw6cgYnVsdW5hbWFkxLEuJyl9PC9iPjxkaXY+JHtlc2MoZC5kZXRhaWx8fCcnKX08L2Rpdj48L2Rpdj5gO3JldHVybjt9Y29uc3QgdGc9ZC50ZWxlZ3JhbXx8e307Y29uc3QgdGdMYWJlbD10Zy5zZW50Pyh0Zy5kdXBsaWNhdGVTdXBwcmVzc2VkPydUZWxlZ3JhbTogRGFoYSDDtm5jZSBnw7ZuZGVyaWxkaSwgdGVrcmFyIGVuZ2VsbGVuZGknOidUZWxlZ3JhbTogT3RvbWF0aWsgZ8O2bmRlcmlsZGknKToodGcuZXJyb3J8fHRnLnJlYXNvbj9gVGVsZWdyYW0gZ8O2bmRlcmlsZW1lZGk6ICR7dGcuZXJyb3J8fHRnLnJlYXNvbn1gOidUZWxlZ3JhbSBnw7ZuZGVyaW0gZHVydW11IGRvxJ9ydWxhbmFtYWTEsScpO2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImhlYWQiPjxzcGFuPiR7ZC50eXBlPT09J3N1cnByaXNlJyA/ICfwn46yIE1Bw4cgw5ZOw5wgU8OcUlBSxLBaIDEwIE1Bw4cnIDogZC50eXBlPT09J2xpdmUnID8gJ+KaoSBDQU5MSSBFTiBHw5xWRU7EsEzEsFIgVEVLIFRFUkPEsEgnIDogJ/Cfjq8gTUHDhyDDlk7DnCBLVVBPTlUnfSDCtyAke2VzYyhkLmRhdGUpfTwvc3Bhbj48c3Bhbj48Yj4ke3RnLnNlbnQ/J1RFTEVHUkFNIEfDlk5ERVLEsExExLAnOidHw5ZOREVSxLBNIEtPTlRST0zDnCd9PC9iPjwvc3Bhbj48L2Rpdj48ZGl2IHN0eWxlPSJtYXJnaW46MTBweCAwIj4ke2QucGlja3MubWFwKChwLGkpPT5gPGRpdiBjbGFzcz0ic3RhdHRlYW0iPjxkaXYgY2xhc3M9ImhlYWQiPjxzcGFuPiR7ZXNjKHAubGVhZ3VlKX08L3NwYW4+PHNwYW4+JHtwLm1pbnV0ZSE9bnVsbD9lc2MocC5taW51dGUpKyInIMK3IFNrb3I6ICIrZXNjKHAuY3VycmVudFNjb3JlfHwnMC0wJyk6J01hw6cgw7Zuw7wnfTwvc3Bhbj48L2Rpdj48ZGl2IHN0eWxlPSJmb250LXdlaWdodDo4NTA7bWFyZ2luOjhweCAwIj4ke2VzYyhwLmhvbWUpfSBWUyAke2VzYyhwLmF3YXkpfTwvZGl2PjxkaXYgY2xhc3M9InN0YXRsaW5lIj48c3Bhbj5UZXJjaWg8L3NwYW4+PGI+JHtlc2MocC5tYXJrZXQpfTwvYj48L2Rpdj48ZGl2IGNsYXNzPSJzbWFsbCI+T3JhbiBrYXluYcSfxLE6ICR7ZXNjKHAuc291cmNlfHwnQmVsaXJ0aWxtZWRpJyl9IMK3ICR7ZXNjKHAub2Rkc0Jhc2lzfHwnT3JhbiBrYXluYcSfxLEgZG/En3J1bGFubWFsxLEnKX08L2Rpdj4ke3Auc3RhdHNTdW1tYXJ5JiZwLnN0YXRzU3VtbWFyeS5sZW5ndGg/YDxkaXYgY2xhc3M9InNtYWxsIj5DYW5sxLEgaXN0YXRpc3RpazogJHtlc2MocC5zdGF0c1N1bW1hcnkuam9pbignIMK3ICcpKX08L2Rpdj5gOicnfTwvZGl2PmApLmpvaW4oJycpfTwvZGl2PjxkaXYgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPiR7ZXNjKHRnTGFiZWwpfS4gS3Vwb24gw7xyZXRpbGRpxJ9pbmRlIFRlbGVncmFtIGfDtm5kZXJpbWkgb3RvbWF0aWsgZGVuZW5pcjsgbWFudWVsIG9uYXkgZ2VyZWttZXouPC9kaXY+YH0KYXN5bmMgZnVuY3Rpb24gbWFrZUNvdXBvbigpe2NvbnN0IGI9JCgnbWFrZUNvdXBvbicpO2IuZGlzYWJsZWQ9dHJ1ZTt0cnl7aWYoISQoJ2RhdGUnKS52YWx1ZSl0aHJvdyBFcnJvcignw5ZuY2UgbWHDpyB0YXJpaGluaSBzZcOnLicpO2xldCByPWF3YWl0IGZldGNoKCcvYXBpL2NvdXBvbi9iZXN0P2RhdGU9JytlbmNvZGVVUklDb21wb25lbnQoJCgnZGF0ZScpLnZhbHVlKSk7bGV0IGQ9YXdhaXQgci5qc29uKCk7aWYoIXIub2smJiFkLmVycm9yKWQuZXJyb3I9J1RlayBtYcOnIHNlw6dpbGVtZWRpLic7cmVuZGVyQ291cG9uKGQpO2lmKGQubWVzc2FnZSYmZC5zdGF0dXM9PT0nUkVBRFknKSQoJ2NvdXBvblJlc3VsdCcpLmluc2VydEFkamFjZW50SFRNTCgnYmVmb3JlZW5kJyxgPGRpdiBjbGFzcz0ic21hbGwiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+JHtlc2MoZC5tZXNzYWdlKX08L2Rpdj5gKTt9Y2F0Y2goZSl7JCgnY291cG9uUmVzdWx0JykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7Yi5kaXNhYmxlZD1mYWxzZTt9fQphc3luYyBmdW5jdGlvbiBtYWtlU3VycHJpc2VDb3Vwb24oKXtjb25zdCBiPSQoJ21ha2VTdXJwcmlzZUNvdXBvbicpO2IuZGlzYWJsZWQ9dHJ1ZTt0cnl7aWYoISQoJ2RhdGUnKS52YWx1ZSl0aHJvdyBFcnJvcignw5ZuY2UgbWHDpyB0YXJpaGluaSBzZcOnLicpO2NvbnN0IHI9YXdhaXQgZmV0Y2goJy9hcGkvY291cG9uL3N1cnByaXNlP2RhdGU9JytlbmNvZGVVUklDb21wb25lbnQoJCgnZGF0ZScpLnZhbHVlKSk7Y29uc3QgZD1hd2FpdCByLmpzb24oKTtpZighci5vayYmIWQuZXJyb3IpZC5lcnJvcj0nMTAgbWHDp2zEsWsga3Vwb24gb2x1xZ90dXJ1bGFtYWTEsS4nO3JlbmRlckNvdXBvbihkKTt9Y2F0Y2goZSl7JCgnY291cG9uUmVzdWx0JykuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iZXJyIj4ke2VzYyhlLm1lc3NhZ2UpfTwvc3Bhbj5gfWZpbmFsbHl7Yi5kaXNhYmxlZD1mYWxzZTt9fQphc3luYyBmdW5jdGlvbiBtYWtlTGl2ZUJlc3QoKXtjb25zdCBiPSQoJ21ha2VMaXZlQmVzdCcpO2IuZGlzYWJsZWQ9dHJ1ZTt0cnl7bGV0IGRhdGU9JCgnZGF0ZScpLnZhbHVlfHxuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwxMCk7bGV0IHI9YXdhaXQgZmV0Y2goJy9hcGkvY291cG9uL2xpdmUtYmVzdD9kYXRlPScrZW5jb2RlVVJJQ29tcG9uZW50KGRhdGUpKTtsZXQgZD1hd2FpdCByLmpzb24oKTtpZighci5vayYmIWQuZXJyb3IpZC5lcnJvcj0nQ2FubMSxIHRlcmNpaCBidWx1bmFtYWTEsS4nO3JlbmRlckNvdXBvbihkKTtpZihkLm1lc3NhZ2UmJmQuc3RhdHVzPT09J1JFQURZJykkKCdjb3Vwb25SZXN1bHQnKS5pbnNlcnRBZGphY2VudEhUTUwoJ2JlZm9yZWVuZCcsYDxkaXYgY2xhc3M9InNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPiR7ZXNjKGQubWVzc2FnZSl9PC9kaXY+YCk7fWNhdGNoKGUpeyQoJ2NvdXBvblJlc3VsdCcpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImVyciI+JHtlc2MoZS5tZXNzYWdlKX08L3NwYW4+YH1maW5hbGx5e2IuZGlzYWJsZWQ9ZmFsc2U7fX0KYXN5bmMgZnVuY3Rpb24gYXBwcm92ZUFuYWx5c2lzKGlkLG1vZGUpe2NvbnN0IG1hdGNoPVsuLi5tYXRjaGVzLC4uLmJ1bGxldGluTWF0Y2hlc10uZmluZCh4PT5OdW1iZXIoeC5pZCk9PT1OdW1iZXIoaWQpKTtjb25zdCBib3g9JCgnYScraWQpO2lmKCFtYXRjaHx8IWJveClyZXR1cm47Y29uc3QgdmFscz17fTtib3gucXVlcnlTZWxlY3RvckFsbCgnLnRhYmxlIHRyJykuZm9yRWFjaChyb3c9Pntjb25zdCBjPXJvdy5xdWVyeVNlbGVjdG9yQWxsKCd0ZCcpO2lmKGMubGVuZ3RoPT09Mil2YWxzW2NbMF0udGV4dENvbnRlbnQudHJpbSgpXT1jWzFdLnRleHRDb250ZW50LnRyaW0oKX0pO2NvbnN0IGFuYWx5c2lzPXttYWluUGljazp2YWxzWydBTkEgVEVSQ8SwSCddfHwn4oCUJyxhbHRlcm5hdGl2ZTp2YWxzWydBTFRFUk5BVMSwRiddfHwn4oCUJyxoYWxmVGltZVNjb3JlOnZhbHNbJ8SwWSBTS09SJ118fCfigJQnLGZ1bGxUaW1lU2NvcmU6dmFsc1snTVMgU0tPUiddfHwn4oCUJyxsaXZlUGljazp2YWxzWydDQU5MSSBURVJDxLBIJ118fCfigJQnfTt0cnl7YXdhaXQgZmV0Y2goJy9hcGkvYW5hbHlzZXMvYXBwcm92ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHtmaXh0dXJlSWQ6TnVtYmVyKGlkKSxtYXRjaERhdGU6bWF0Y2guZml4dHVyZURhdGV8fCcnLGhvbWU6bWF0Y2guaG9tZSxhd2F5Om1hdGNoLmF3YXksYW5hbHlzaXN9KX0pO2FsZXJ0KCdBbmFsaXogb25heWxhbmTEsS4nKTt9Y2F0Y2goZSl7YWxlcnQoJ0hhdGE6ICcrZS5tZXNzYWdlKTt9fQpmdW5jdGlvbiBjbG9zZUFyY2hpdmVzKCl7JCgnYW5hbHlzZXNBcmNoaXZlJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7JCgnY291cG9uc0FyY2hpdmUnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTt9CmFzeW5jIGZ1bmN0aW9uIGxvYWRBcmNoaXZlcyh3aGljaCl7Y29uc3QgYm94PSQod2hpY2g9PT0nYW5hbHlzaXMnPydhbmFseXNlc0FyY2hpdmVMaXN0JzonY291cG9uc0FyY2hpdmVMaXN0Jyk7Ym94LnRleHRDb250ZW50PSdZw7xrbGVuaXlvcuKApic7dHJ5e2xldCByPWF3YWl0IGZldGNoKCcvYXBpL2FyY2hpdmVzJyksaj1hd2FpdCByLmpzb24oKTtpZih3aGljaD09PSdhbmFseXNpcycpe2JveC5pbm5lckhUTUw9KGouYW5hbHlzZXN8fFtdKS5sZW5ndGg/ai5hbmFseXNlcy5tYXAoeD0+YDxkaXYgY2xhc3M9ImFyY2hpdmUtaXRlbSI+PGRpdiBjbGFzcz0idGl0bGUiPiR7ZXNjKHguaG9tZV90ZWFtKX0gVlMgJHtlc2MoeC5hd2F5X3RlYW0pfTwvZGl2PjxkaXYgY2xhc3M9InJvd2xpbmUiPjxzcGFuPkFuYSB0ZXJjaWg8L3NwYW4+PGI+JHtlc2MoeC5hbmFseXNpcz8ubWFpblBpY2t8fCfigJQnKX08L2I+PC9kaXY+PGRpdiBjbGFzcz0icm93bGluZSI+PHNwYW4+xLBZIC8gTVMgc2tvcjwvc3Bhbj48Yj4ke2VzYyh4LmFuYWx5c2lzPy5oYWxmVGltZVNjb3JlfHwn4oCUJyl9IC8gJHtlc2MoeC5hbmFseXNpcz8uZnVsbFRpbWVTY29yZXx8J+KAlCcpfTwvYj48L2Rpdj48L2Rpdj5gKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkthecSxdCB5b2suPC9kaXY+Jzt9ZWxzZXtib3guaW5uZXJIVE1MPShqLmNvdXBvbnN8fFtdKS5sZW5ndGg/ai5jb3Vwb25zLm1hcCh4PT5gPGRpdiBjbGFzcz0iYXJjaGl2ZS1pdGVtIj48ZGl2IGNsYXNzPSJ0aXRsZSI+JHt4LmlzTGl2ZT8n8J+OryBDYW5sxLEgS29tYmluJzonS3Vwb24nfSDCtyAke2VzYyh4LmRhdGV8fCcnKX08L2Rpdj48L2Rpdj5gKS5qb2luKCcnKTonPGRpdiBjbGFzcz0iZW1wdHkiPkthecSxdCB5b2suPC9kaXY+Jzt9fWNhdGNoKGUpe2JveC5pbm5lckhUTUw9YDxkaXYgY2xhc3M9ImVyciI+JHtlc2MoZS5tZXNzYWdlKX1gIH19CndpbmRvdy5hbmFseXplPWFuYWx5emU7d2luZG93LnN0YXRzPXN0YXRzOyQoJ3JlZnJlc2gnKS5vbmNsaWNrPWxpdmU7JCgnYnVsbGV0aW4nKS5vbmNsaWNrPWJ1bGxldGluOyQoJ3NlYXJjaE1hdGNoJykub25jbGljaz1zZWFyY2hNYXRjaDskKCdtYXRjaFNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLGU9PntpZihlLmtleT09PSdFbnRlcicpc2VhcmNoTWF0Y2goKX0pOyQoJ2NsZWFyTWF0Y2hTZWFyY2gnKS5vbmNsaWNrPWNsZWFyTWF0Y2hTZWFyY2g7JCgnbWFrZUNvdXBvbicpLm9uY2xpY2s9bWFrZUNvdXBvbjskKCdtYWtlU3VycHJpc2VDb3Vwb24nKS5vbmNsaWNrPW1ha2VTdXJwcmlzZUNvdXBvbjskKCdtYWtlTGl2ZUJlc3QnKS5vbmNsaWNrPW1ha2VMaXZlQmVzdDskKCdzaG93QW5hbHlzZXMnKS5vbmNsaWNrPSgpPT57Y2xvc2VBcmNoaXZlcygpOyQoJ2FuYWx5c2VzQXJjaGl2ZScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO2xvYWRBcmNoaXZlcygnYW5hbHlzaXMnKTt9OyQoJ3Nob3dDb3Vwb25zJykub25jbGljaz0oKT0+e2Nsb3NlQXJjaGl2ZXMoKTskKCdjb3Vwb25zQXJjaGl2ZScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO2xvYWRBcmNoaXZlcygnY291cG9uJyk7fTskKCdmaWx0ZXInKS5vbmNoYW5nZT1yZW5kZXI7bGV0IGQ9bmV3IERhdGUoKTskKCdkYXRlJykudmFsdWU9YCR7ZC5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkLmdldE1vbnRoKCkrMSkucGFkU3RhcnQoMiwnMCcpfS0ke1N0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwnMCcpfWA7bGl2ZSgpOwo8L3NjcmlwdD48L2JvZHk+PC9odG1sPg==", "base64").toString("utf8");
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
    return res.type("html").send(html);
  } catch {
    return res.type("html").send(EMBEDDED_INDEX_HTML);
  }
});
app.use(express.static(path.join(ROOT, "public")));

const providerCache = new Map();
const providerInFlight = new Map();
const archives = { analyses: [], coupons: [] };
const predictionTracking = [];
const livePredictionTracking = [];
const { Pool } = pg;
const databasePool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
let archiveDatabaseReady = Promise.resolve();
if (databasePool) {
  archiveDatabaseReady = (async () => {
    try {
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_archive (
        id BIGSERIAL PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('analysis','coupon')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await databasePool.query("CREATE INDEX IF NOT EXISTS winscope_archive_category_id_idx ON winscope_archive(category, id DESC)");
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_coupon_predictions (
        tracking_id BIGSERIAL PRIMARY KEY,
        coupon_key TEXT NOT NULL,
        coupon_type TEXT NOT NULL,
        fixture_id BIGINT NOT NULL,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        league TEXT,
        market TEXT NOT NULL,
        start_score TEXT,
        actual_score TEXT,
        outcome TEXT,
        match_date TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ,
        telegram_notified_at TIMESTAMPTZ,
        UNIQUE(coupon_key, fixture_id, market)
      )`);
      await databasePool.query("ALTER TABLE winscope_coupon_predictions ADD COLUMN IF NOT EXISTS telegram_notified_at TIMESTAMPTZ");
      await databasePool.query("CREATE INDEX IF NOT EXISTS winscope_coupon_predictions_created_idx ON winscope_coupon_predictions(created_at DESC)");
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_predictions (
        fixture_id BIGINT PRIMARY KEY, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
        predicted_ht TEXT, predicted_ft TEXT, alternative_ft TEXT,
        actual_ht TEXT, actual_ft TEXT, exact_ft BOOLEAN, exact_ht BOOLEAN,
        match_date TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ
      )`);
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_telegram_fixture_sent (
        fixture_id BIGINT PRIMARY KEY,
        match_date DATE,
        coupon_type TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // Telegram tekrar engeli artık maç + kupon türü + market bazındadır.
      // Eski fixture-only tablo korunur; geçmiş kayıtlar silinmez veya yanlışlıkla
      // farklı marketlerin gönderimini engellemez.
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_telegram_delivery_sent (
        fixture_id BIGINT NOT NULL,
        coupon_type TEXT NOT NULL,
        market TEXT NOT NULL,
        match_date DATE,
        telegram_message_id BIGINT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fixture_id, coupon_type, market)
      )`);
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_live_predictions (
        prediction_id BIGSERIAL PRIMARY KEY,
        fixture_id BIGINT NOT NULL, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
        market TEXT NOT NULL, signal_key TEXT NOT NULL, league TEXT, match_date TEXT, start_score TEXT, minute INTEGER,
        actual_score TEXT, outcome TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      )`);
      // Backfill schema for databases created by older deployments. CREATE TABLE IF NOT EXISTS
      // does not add columns to an existing table, which previously broke weekly tracking.
      await databasePool.query(`ALTER TABLE winscope_live_predictions
        ADD COLUMN IF NOT EXISTS prediction_id BIGSERIAL,
        ADD COLUMN IF NOT EXISTS fixture_id BIGINT,
        ADD COLUMN IF NOT EXISTS home_team TEXT,
        ADD COLUMN IF NOT EXISTS away_team TEXT,
        ADD COLUMN IF NOT EXISTS market TEXT,
        ADD COLUMN IF NOT EXISTS signal_key TEXT,
        ADD COLUMN IF NOT EXISTS league TEXT,
        ADD COLUMN IF NOT EXISTS match_date TEXT,
        ADD COLUMN IF NOT EXISTS start_score TEXT,
        ADD COLUMN IF NOT EXISTS minute INTEGER,
        ADD COLUMN IF NOT EXISTS actual_score TEXT,
        ADD COLUMN IF NOT EXISTS outcome TEXT,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`);
      // Existing databases may already have signal_key as NOT NULL. Backfill old rows
      // before enforcing the constraint so tracking writes never fail on a missing key.
      await databasePool.query(`UPDATE winscope_live_predictions
        SET signal_key = COALESCE(NULLIF(signal_key, ''), fixture_id::TEXT || ':' || COALESCE(market, 'unknown'))
        WHERE signal_key IS NULL OR signal_key = ''`);
      await databasePool.query(`ALTER TABLE winscope_live_predictions ALTER COLUMN signal_key SET NOT NULL`);
      // Migrate older installs where fixture_id was the primary key so one match can
      // store multiple distinct markets without losing existing tracking rows.
      await databasePool.query(`ALTER TABLE winscope_live_predictions ADD COLUMN IF NOT EXISTS prediction_id BIGSERIAL`);
      await databasePool.query(`DO $$ DECLARE pk_name TEXT; BEGIN
        SELECT conname INTO pk_name FROM pg_constraint
        WHERE conrelid='winscope_live_predictions'::regclass AND contype='p' LIMIT 1;
        IF pk_name IS NOT NULL THEN EXECUTE format('ALTER TABLE winscope_live_predictions DROP CONSTRAINT %I', pk_name); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='winscope_live_predictions'::regclass AND contype='p') THEN
          ALTER TABLE winscope_live_predictions ADD CONSTRAINT winscope_live_predictions_pkey PRIMARY KEY (prediction_id);
        END IF;
      END $$`);
      await databasePool.query(`CREATE UNIQUE INDEX IF NOT EXISTS winscope_live_predictions_fixture_market_uidx ON winscope_live_predictions(fixture_id, market)`);
      const [analysisRows, couponRows, sentRows, predictionRows, livePredictionRows] = await Promise.all([
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'analysis' ORDER BY id DESC LIMIT 100"),
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'coupon' ORDER BY id DESC LIMIT 50"),
        databasePool.query("SELECT fixture_id, coupon_type, market, match_date FROM winscope_telegram_delivery_sent"),
        databasePool.query("SELECT * FROM winscope_predictions ORDER BY created_at DESC LIMIT 500"),
        databasePool.query("SELECT * FROM winscope_live_predictions ORDER BY created_at DESC LIMIT 500")
      ]);
      archives.analyses = analysisRows.rows.map(row => row.payload);
      archives.coupons = couponRows.rows.map(row => row.payload);
      let couponBackfilled = 0;
      for (const archivedCoupon of archives.coupons) {
        const picks = Array.isArray(archivedCoupon?.picks) ? archivedCoupon.picks : [];
        const couponKey = String(archivedCoupon?.draftId || `${archivedCoupon?.date || "unknown"}:${archivedCoupon?.type || "coupon"}:${archivedCoupon?.createdAt || ""}`);
        for (const pick of picks) {
          const fixtureId = Number(pick?.fixtureId || pick?.fixture_id || 0);
          const market = String(pick?.market || pick?.mainPick || "").trim();
          if (!fixtureId || !market || !pick?.home || !pick?.away) continue;
          const result = await databasePool.query(
            `INSERT INTO winscope_coupon_predictions
              (coupon_key,coupon_type,fixture_id,home_team,away_team,league,market,start_score,match_date,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,NOW()))
             ON CONFLICT(coupon_key,fixture_id,market) DO NOTHING`,
            [couponKey, String(archivedCoupon.type || "prematch"), fixtureId, String(pick.home), String(pick.away),
             String(pick.league || ""), market, String(pick.currentScore || pick.startScore || "0-0"),
             String(archivedCoupon.date || "").slice(0,10) || null, archivedCoupon.createdAt || null]
          );
          couponBackfilled += result.rowCount;
        }
      }
      console.log(`[Coupon tracking] Arşivden takip kaydı aktarıldı: ${couponBackfilled}`);
      predictionTracking.push(...predictionRows.rows.map(row => ({
        fixtureId:Number(row.fixture_id), home:row.home_team, away:row.away_team,
        predictedHT:row.predicted_ht, predictedFT:row.predicted_ft, alternativeFT:row.alternative_ft,
        actualHT:row.actual_ht, actualFT:row.actual_ft, exactFT:row.exact_ft, exactHT:row.exact_ht,
        matchDate:row.match_date, settled:Boolean(row.settled_at), createdAt:row.created_at
      })));
      livePredictionTracking.push(...livePredictionRows.rows.map(row => ({
        fixtureId:Number(row.fixture_id), home:row.home_team, away:row.away_team,
        market:row.market, league:row.league, matchDate:row.match_date, startScore:row.start_score,
        minute:row.minute, actualScore:row.actual_score, outcome:row.outcome,
        settled:Boolean(row.settled_at), createdAt:row.created_at
      })));
      for (const row of sentRows.rows) {
        telegramSentKeys.add(telegramDeliveryKey(row.fixture_id, row.coupon_type, row.market));
        if (row.coupon_type && row.match_date) {
          const matchDate = row.match_date instanceof Date ? row.match_date.toISOString().slice(0, 10) : String(row.match_date).slice(0, 10);
          autoSentFixtureKeys.add(autoLivePickKey(row.coupon_type, matchDate, { fixtureId: row.fixture_id, market: row.market }));
        }
      }
      console.log(`[Archive] PostgreSQL arşivi yüklendi: analyses=${archives.analyses.length}, coupons=${archives.coupons.length}`);
    } catch (error) {
      console.error(`[Archive] PostgreSQL başlatılamadı; servis bellek içi arşivle devam edecek: ${error.message}`);
    }
  })();
}
async function saveArchiveItem(category, payload) {
  if (!databasePool) return { persisted: false, reason: "DATABASE_URL tanımlı değil; kayıt yalnızca çalışan süreç belleğinde tutulur." };
  try {
    await archiveDatabaseReady;
    await databasePool.query("INSERT INTO winscope_archive(category, payload) VALUES ($1, $2::jsonb)", [category, JSON.stringify(payload)]);
    await databasePool.query(`DELETE FROM winscope_archive WHERE id IN (
      SELECT id FROM winscope_archive WHERE category = $1 ORDER BY id DESC OFFSET $2
    )`, [category, category === "analysis" ? 100 : 50]);
    return { persisted: true };
  } catch (error) {
    console.error(`[Archive] Kayıt kalıcılaştırılamadı (${category}): ${error.message}`);
    return { persisted: false, error: error.message };
  }
}
async function saveCouponTracking(coupon) {
  const picks = Array.isArray(coupon?.picks) ? coupon.picks : [];
  const couponKey = String(coupon?.draftId || `${coupon?.date || "unknown"}:${coupon?.type || "coupon"}:${Date.now()}`);
  if (!databasePool) return { saved: 0, persistent: false };
  let saved = 0;
  for (const pick of picks) {
    const fixtureId = Number(pick?.fixtureId || 0);
    const market = String(pick?.market || "").trim();
    if (!fixtureId || !market || !pick?.home || !pick?.away) continue;
    const result = await databasePool.query(
      `INSERT INTO winscope_coupon_predictions
        (coupon_key,coupon_type,fixture_id,home_team,away_team,league,market,start_score,match_date)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(coupon_key,fixture_id,market) DO NOTHING`,
      [couponKey, String(coupon.type || "prematch"), fixtureId, String(pick.home), String(pick.away),
       String(pick.league || ""), market, String(pick.currentScore || pick.startScore || "0-0"),
       String(coupon.date || "").slice(0,10) || null]
    );
    saved += result.rowCount;
  }
  return { saved, persistent: true };
}
// Aynı kuponun art arda tıklama/yenilemelerde tekrar Telegram'a gitmesini önler.
const telegramDeliveryCache = new Map();
// Otomatik gönderimde aynı gün aynı maçı tekrar seçmemek için takip edilir.
const autoSentFixtureKeys = new Set();
// Aynı maçın farklı pazarlarını ayrı bildirimler olarak izler.
// PostgreSQL varsa sunucu yeniden başlasa da tekrar engeli korunur.
const telegramSentKeys = new Set();
function telegramDeliveryKey(fixtureId, couponType, market) {
  return `${Number(fixtureId)}|${String(couponType || "")}|${String(market || "").trim().toLocaleLowerCase("tr-TR")}`;
}
function autoLivePickKey(mode, date, pick) {
  return `${mode}|${date}|${Number(pick.fixtureId)}|${String(pick.market || "").trim().toLocaleLowerCase("tr-TR")}`;
}
let autoLiveTaskInFlight = false;
let autoPrematchTaskInFlight = false;
// Telegram'a gönderilmiş kuponlardaki maçlar için gol/skor değişimi takibi.
// Not: Bu izleme durumu bellektedir; süreç yeniden başlarsa kupon yeniden gönderilince takip tekrar kurulur.
const goalTrackedFixtures = new Map();
const goalScoreCache = new Map();
let goalScanInFlight = false;
// API-Football plan limitine takılmamak için istekleri tek kuyruktan geçir.
// 260 ms aralık yaklaşık 231 istek/dk ile 300/dk sınırının altında kalır.
let providerQueue = Promise.resolve();
let lastProviderRequestAt = 0;
let providerCooldownUntil = 0;
let providerQuotaBlockedUntil = 0;
const PROVIDER_MIN_INTERVAL_MS = 260;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cachedProviderRequest(cacheKey, pathname, ttlMs = 30000) {
  const now = Date.now();
  if (now < providerQuotaBlockedUntil) {
    const minutes = Math.ceil((providerQuotaBlockedUntil - now) / 60000);
    throw new Error(`API-Football kotası geçici olarak durduruldu; yeni istek gönderilmiyor. Yaklaşık ${minutes} dakika sonra yeniden denenecek.`);
  }
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  if (!API_KEY) throw new Error("Render Environment Variables içinde API_FOOTBALL_KEY eksik.");

  const task = providerQueue.then(async () => {
    const secondCheck = providerCache.get(cacheKey);
    if (secondCheck && Date.now() - secondCheck.at < ttlMs) return secondCheck.payload;
    const allowedAt = Math.max(lastProviderRequestAt + PROVIDER_MIN_INTERVAL_MS, providerCooldownUntil);
    if (allowedAt > Date.now()) await delay(allowedAt - Date.now());
    lastProviderRequestAt = Date.now();
    const response = await fetch(`${BASE_URL}${pathname}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("API-Football geçerli JSON döndürmedi."); }
    const errors = payload.errors && Object.keys(payload.errors).length ? payload.errors : null;
    const errorText = errors ? JSON.stringify(errors) : "";
    if (!response.ok || errors) {
      const quotaExhausted = /request limit|requests limit|quota|subscription plan|daily limit|monthly limit|you have reached/i.test(errorText);
      if (quotaExhausted) {
        // Kota gerçekten bittiyse her 15 saniyede yeniden denemek kotayı düzeltmez.
        // 6 saatlik devre kesici, gereksiz tekrar isteklerini durdurur.
        providerQuotaBlockedUntil = Date.now() + 6 * 60 * 60 * 1000;
        providerCooldownUntil = providerQuotaBlockedUntil;
        throw new Error(`API-Football kotası dolu; 6 saatlik koruma devrede. ${errorText}`);
      }
      if (response.status === 429 || /rate.?limit|too many requests|per-minute/i.test(errorText)) {
        providerCooldownUntil = Date.now() + 60_000;
        throw new Error(`API-Football hız sınırına ulaşıldı; 60 saniye bekleme uygulandı. ${errorText}`);
      }
      throw new Error(`API-Football hatası: ${errors ? errorText : `HTTP ${response.status}`}`);
    }
    providerCache.set(cacheKey, { at: Date.now(), payload });
    // Bellek kullanımını sınırlı tut.
    if (providerCache.size > 2500) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [key, value] of providerCache) if (value.at < cutoff) providerCache.delete(key);
      while (providerCache.size > 2000) providerCache.delete(providerCache.keys().next().value);
    }
    return payload;
  });
  providerQueue = task.catch(() => undefined);
  providerInFlight.set(cacheKey, task);
  try { return await task; }
  finally { providerInFlight.delete(cacheKey); }
}

function normalizeProviderMatch(match) {
  const homeName = match.teams?.home?.name || match.home || "Ev sahibi";
  const awayName = match.teams?.away?.name || match.away || "Deplasman";
  const leagueName = match.league?.name || match.league || "Lig";
  const countryName = match.league?.country || match.country || "";
  const idNum = Number(match.fixture?.id ?? match.id) || 0;
  let status = String(match.fixture?.status?.short || match.status || "NS").toUpperCase();
  if (["FT", "AET", "PEN"].includes(status)) status = "FT";
  else if (["1H", "2H", "HT", "LIVE", "IN_PLAY", "ET", "BT", "P"].includes(status)) status = "LIVE";
  else if (["NS", "TBD", "PST", "CANC", "ABD", "AWD", "WO"].includes(status)) status = status === "NS" ? "NS" : status;
  return {
    id: idNum, homeId: Number(match.teams?.home?.id) || null, awayId: Number(match.teams?.away?.id) || null,
    leagueId: Number(match.league?.id) || null, season: Number(match.league?.season) || null,
    league: String(leagueName), country: String(countryName),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null, status,
    home: String(homeName), away: String(awayName),
    homeScore: match.goals?.home ?? 0, awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

function computeAnalysis(match) {
  const minute = Number(match.minute || 0);
  const home = Number(match.homeScore || 0), away = Number(match.awayScore || 0);
  const total = home + away, live = match.status === "LIVE", finished = match.status === "FT";
  let ht = "Tahmin: 1-0", ft = "Tahmin: 2-1", mainPick = "MS 2.5 ÜST", alternative = "KG VAR";
  if (finished) {
    ht = `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`;
    ft = `${home}-${away}`;
  } else if (live) {
    if (minute >= 45 && match.htHomeScore != null && match.htAwayScore != null) ht = `${match.htHomeScore}-${match.htAwayScore} (İY Gerçek)`;
    else if (minute < 45 && total > 0) ht = `Tahmin: ${home}-${away}`;
    else if (minute <= 30) ht = "Tahmin: 1-0";
    else ht = "Tahmin: 0-0";
    ft = minute >= 75 ? `Tahmin: ${home}-${away}` : `Tahmin: ${home + 1}-${away}`;
    if (minute < 33 && total === 0) { mainPick = "İY 0.5 ÜST"; alternative = "MS 1.5 ÜST"; }
    else if (minute >= 33 && minute < 45 && total === 0) { mainPick = "MS 1.5 ÜST"; alternative = "KG VAR"; }
    else if (minute >= 45 && total < 2) { mainPick = "MS 1.5 ÜST"; alternative = "KG VAR"; }
    else { mainPick = "MS 1.5 ÜST"; alternative = "KG VAR"; }
  } else {
    ht = "Tahmin: 1-0";
    ft = "Tahmin: 2-1";
    mainPick = "MS 2.5 ÜST"; alternative = "KG VAR";
  }
  return { halfTimeScore: ht, fullTimeScore: ft, mainPick, alternative, surprise: "MS 3.5 ÜST" };
}

function bookmakerRows(oddsRow) {
  if (!oddsRow) return [];
  if (Array.isArray(oddsRow.bookmakers) && oddsRow.bookmakers.length) return oddsRow.bookmakers;
  if (Array.isArray(oddsRow.odds) && oddsRow.odds.length) {
    return [{
      name: oddsRow.bookmaker?.name || oddsRow.bookmaker || oddsRow.source || "API-Football",
      bets: oddsRow.odds.map(item => ({ name: item.name || item.bet || "", values: item.values || [] }))
    }];
  }
  return [];
}

function oddsForFixture(oddsRow) {
  const markets = new Map();
  const add = (book, key, side, odd) => {
    if (!Number.isFinite(odd) || odd <= 1.01) return;
    const mapKey = `${book}|${key}`;
    if (!markets.has(mapKey)) markets.set(mapKey, { market: key, bookmaker: book, over: null, under: null, yes: null, no: null, home: null, draw: null, away: null });
    const item = markets.get(mapKey);
    item[side] = odd;
  };
  for (const bookmaker of bookmakerRows(oddsRow)) {
    const book = String(bookmaker.name || "Kaynak belirtilmedi");
    for (const bet of (bookmaker.bets || [])) {
      const name = String(bet.name || "").toLowerCase().replace(/[–—]/g, "-");
      const isHalf = /first half|1st half|half.?time|1st period|first period/.test(name);
      const isHomeTeam = /home team|home goals|team 1 total|team 1 goals|team total - home/.test(name);
      const isAwayTeam = /away team|away goals|team 2 total|team 2 goals|team total - away/.test(name);
      const isBtts = /both teams to score|both teams score|btts/.test(name);
      const isTotal = /over.?under|total goals|match goals|goal line|goals total|total/.test(name) && !isHomeTeam && !isAwayTeam;
      const isWinner = /match winner|1x2|full.?time result|match result|regular time result|winner/.test(name);
      for (const value of (bet.values || [])) {
        const label = String(value.value ?? value.name ?? "").toLowerCase().trim();
        const odd = Number(value.odd);
        if (!Number.isFinite(odd) || odd <= 1.01) continue;
        if (isWinner) {
          if (/^(home|1|team 1|1 \(home\))$/.test(label)) add(book, "MS 1", "home", odd);
          else if (/^(draw|x|tie)$/.test(label)) add(book, "MS 1", "draw", odd);
          else if (/^(away|2|team 2|2 \(away\))$/.test(label)) add(book, "MS 1", "away", odd);
          continue;
        }
        if (isBtts) {
          if (/^(yes|y|both teams to score - yes)$/.test(label)) add(book, "KG VAR", "yes", odd);
          else if (/^(no|n|both teams to score - no)$/.test(label)) add(book, "KG VAR", "no", odd);
          continue;
        }
        const overMatch = label.match(/over\s*([0-9]+[.,][0-9]+)/);
        const underMatch = label.match(/under\s*([0-9]+[.,][0-9]+)/);
        const lineMatch = label.match(/([0-9]+[.,][0-9]+)/);
        const line = (overMatch || underMatch || lineMatch)?.[1]?.replace(',', '.');
        if (!line) continue;
        const side = overMatch ? "over" : underMatch ? "under" : null;
        if (!side) continue;
        let key = null;
        if (isHomeTeam && Number(line) === 1.5) key = "EV 1.5 ÜST";
        else if (isAwayTeam && Number(line) === 1.5) key = "DEP 1.5 ÜST";
        else if (isHalf && [0.5, 1.5, 2.5].includes(Number(line))) key = `İY ${line} ÜST`;
        else if (isTotal && [0.5, 1.5, 2.5, 3.5, 5.5].includes(Number(line))) key = `MS ${line} ÜST`;
        if (key) add(book, key, side, odd);
      }
    }
  }
  const candidates = [];
  for (const item of markets.values()) {
    let pct = null;
    let outcomeProbabilities = null;
    if (item.over && item.under) pct = 100 * (1 / item.over) / ((1 / item.over) + (1 / item.under));
    else if (item.yes && item.no) pct = 100 * (1 / item.yes) / ((1 / item.yes) + (1 / item.no));
    else if (item.home && item.draw && item.away) {
      const inv = [1 / item.home, 1 / item.draw, 1 / item.away], sum = inv.reduce((a,b)=>a+b,0);
      outcomeProbabilities = { home: 100 * inv[0] / sum, draw: 100 * inv[1] / sum, away: 100 * inv[2] / sum };
      pct = outcomeProbabilities.home;
    }
    const odd = item.over || item.yes || item.home;
    if (pct == null || !Number.isFinite(pct)) continue;
    const ranks = { "EV 1.5 ÜST": 1, "DEP 1.5 ÜST": 1, "İY 0.5 ÜST": 2, "MS 0.5 ÜST": 2, "İY 1.5 ÜST": 3, "MS 1.5 ÜST": 3, "MS 2.5 ÜST": 4, "KG VAR": 5, "MS 3.5 ÜST": 6, "MS 5.5 ÜST": 8 };
    candidates.push({ market: item.market, odd, probability: pct, rank: ranks[item.market] ?? 9, bookmaker: item.bookmaker,
      homeOdd: item.market === "MS 1" ? item.home : null, drawOdd: item.market === "MS 1" ? item.draw : null,
      awayOdd: item.market === "MS 1" ? item.away : null, outcomeProbabilities });
  }
  // If API-Football has multiple bookmakers, keep each book's pair intact and prefer Bet365 only as a tie-break.
  return candidates.sort((a,b) => (/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || b.probability-a.probability || a.rank-b.rank);
}

function teamGoalAlternative(fixture, forms, stats, liveOddsRow, prematchOddsRow) {
  if (!stats?.available || !forms?.home?.available || !forms?.away?.available) return null;
  const preferredOdds = liveOddsRow && (liveOddsRow.response || []).length ? liveOddsRow : prematchOddsRow;
  let homeAhOdd = null, awayAhOdd = null, oddsSource = null;
  for (const book of bookmakerRows(preferredOdds)) {
    for (const bet of (book.bets || [])) {
      if (!/asian handicap|handicap/.test(String(bet.name || '').toLowerCase())) continue;
      let h = null, a = null;
      for (const value of (bet.values || [])) {
        const label = String(value.value ?? value.name ?? '').toLowerCase().replace(/[−–—]/g, '-').trim();
        const odd = Number(value.odd);
        if (!Number.isFinite(odd) || odd <= 1.01) continue;
        if (/(home|team 1|^1\b)/.test(label) && /-\s*0[.,]5/.test(label)) h = odd;
        if (/(away|team 2|^2\b)/.test(label) && /\+\s*0[.,]5/.test(label)) a = odd;
        // Some feeds put the selection name and handicap in separate fields.
        if (/(home|team 1|^1\b)/.test(label) && /0[.,]5/.test(label) && !/[+-]\s*0[.,]5/.test(label)) h = odd;
        if (/(away|team 2|^2\b)/.test(label) && /0[.,]5/.test(label) && !/[+-]\s*0[.,]5/.test(label)) a = odd;
      }
      if (h && a) { homeAhOdd = h; awayAhOdd = a; oddsSource = book.name || 'API-Football'; break; }
    }
    if (homeAhOdd && awayAhOdd) break;
  }
  const sidePressure = side => {
    const x = stats[side] || {};
    return Number(x.shotsOnTarget || 0) * 2.5 + Number(x.totalShots || 0) * 0.45 + Number(x.corners || 0) * 0.8;
  };
  const homePressure = sidePressure('home'), awayPressure = sidePressure('away');
  // Alternative market is EV/DEP 1.5 ÜST, so rank direction using each team's 1.5+ goal form first.
  const homeFormPct = Number(forms.home.teamGoalsOver15Pct ?? forms.home.teamGoalsOver05Pct ?? 0);
  const awayFormPct = Number(forms.away.teamGoalsOver15Pct ?? forms.away.teamGoalsOver05Pct ?? 0);
  let homeOddsPct = null, awayOddsPct = null;
  if (homeAhOdd && awayAhOdd) {
    const hi = 1 / homeAhOdd, ai = 1 / awayAhOdd, sum = hi + ai;
    homeOddsPct = 100 * hi / sum; awayOddsPct = 100 * ai / sum;
  }
  // Team statistics are mandatory; odds and last-five scoring form confirm rather than invent the side.
  let homeScore = homePressure * 0.45 + homeFormPct * 0.25;
  let awayScore = awayPressure * 0.45 + awayFormPct * 0.25;
  if (homeOddsPct != null && awayOddsPct != null) {
    homeScore += homeOddsPct * 0.30;
    awayScore += awayOddsPct * 0.30;
  }
  if (Math.abs(homeScore - awayScore) < 2.0) return {
    market: null, pressureSide: 'Dengeli', basis: `Takım baskısı yakın; ev ${homePressure.toFixed(1)} / dep ${awayPressure.toFixed(1)}${homeOddsPct == null ? '' : `; AH -0.5 yönü ${homeOddsPct >= awayOddsPct ? 'ev' : 'dep'}`}`
  };
  const currentHomeGoals = Number(fixture.homeScore || 0), currentAwayGoals = Number(fixture.awayScore || 0);
  if (currentHomeGoals >= 1 && currentAwayGoals >= 1) return null; // both team 0.5 markets already settled
  const side = currentHomeGoals >= 1 ? 'away' : currentAwayGoals >= 1 ? 'home' : (homeScore > awayScore ? 'home' : 'away');
  // If the selected team's 2+ goals are already scored, its 1.5+ market is settled.
  if ((side === 'home' ? currentHomeGoals : currentAwayGoals) >= 2) return null;
  const sideName = side === 'home' ? fixture.home : fixture.away;
  const market = side === 'home' ? 'EV 1.5 ÜST' : 'DEP 1.5 ÜST';
  const basisParts = [`takım baskısı ev ${homePressure.toFixed(1)} / dep ${awayPressure.toFixed(1)}`, `son 5 maç gol yüzdesi ev %${homeFormPct} / dep %${awayFormPct}`];
  if (homeOddsPct != null) basisParts.push(`AH -0.5 yönü ${homeOddsPct >= awayOddsPct ? 'ev sahibi' : 'deplasman'} (${oddsSource})`);
  else basisParts.push('AH -0.5 oranı bulunamadı; istatistik + form yönü');
  return { market, pressureSide: side === 'home' ? 'Ev sahibi' : 'Deplasman', pressureTeam: sideName, basis: basisParts.join('; ') };
}

function marketSupport(market, homeForm, awayForm) {
  if (!homeForm?.available || !awayForm?.available) return null;
  const avg = (a,b) => a == null || b == null ? null : (Number(a)+Number(b))/2;
  if (market === "EV 1.5 ÜST") return 0.65*Number(homeForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(awayForm.goalsConcededPct ?? 0);
  if (market === "DEP 1.5 ÜST") return 0.65*Number(awayForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(homeForm.goalsConcededPct ?? 0);
  if (market === "MS 2.5 ÜST") return avg(homeForm.over25Pct, awayForm.over25Pct);
  if (market === "MS 3.5 ÜST") return avg(homeForm.over35Pct, awayForm.over35Pct);
  if (market === "MS 1.5 ÜST") return avg(homeForm.over15Pct, awayForm.over15Pct);
  if (market === "MS 0.5 ÜST") return avg(homeForm.over05Pct, awayForm.over05Pct);
  if (market === "KG VAR") return avg(homeForm.bttsPct, awayForm.bttsPct);
  if (market === "İY 0.5 ÜST") return avg(homeForm.htOver05Pct, awayForm.htOver05Pct);
  if (market === "İY 1.5 ÜST") return avg(homeForm.htOver15Pct, awayForm.htOver15Pct);
  return null;
}

async function fetchTeamSeasonGoals(teamId, leagueId, season, venue) {
  if (!teamId || !leagueId || !season || !['home', 'away'].includes(venue)) return null;
  try {
    // Team-season stats change slowly; cache them for 12 hours to conserve API quota.
    const payload = await cachedProviderRequest(
      `team-season:${teamId}:${leagueId}:${season}`,
      `/teams/statistics?team=${encodeURIComponent(teamId)}&league=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}`,
      12 * 60 * 60 * 1000
    );
    const data = payload.response || {};
    const played = Number(data.fixtures?.played?.[venue] || 0);
    const avgFor = Number(data.goals?.for?.average?.[venue]);
    const avgAgainst = Number(data.goals?.against?.average?.[venue]);
    if (played < 5 || !Number.isFinite(avgFor) || !Number.isFinite(avgAgainst)) return null;
    return { played, avgGoalsFor: avgFor, avgGoalsAgainst: avgAgainst };
  } catch (e) {
    // Season stats are supplementary: an endpoint failure must not break the existing form analysis.
    console.warn(`[Team season stats] team=${teamId} league=${leagueId} season=${season}: ${e.message}`);
    return null;
  }
}

async function fetchTeamRecentForm(teamId, fixtureId, leagueId = null, season = null, venue = null) {
  if (!teamId) return { available: false, sampleSize: 0 };
  try {
    const payload = await cachedProviderRequest(`form:${teamId}`, `/fixtures?team=${teamId}&last=10`, 6 * 60 * 60 * 1000);
    const rows = (payload.response || []).filter(row => Number(row.fixture?.id) !== Number(fixtureId) &&
      ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase()) &&
      row.goals?.home != null && row.goals?.away != null)
      .sort((a,b) => new Date(b.fixture?.date || 0) - new Date(a.fixture?.date || 0)).slice(0,5);
    if (rows.length < 5) return { available: false, sampleSize: rows.length };
    const pct = fn => Math.round(100 * vals.filter(fn).length / vals.length);
    const vals = rows.map(r => {
      const isHome = Number(r.teams?.home?.id) === Number(teamId);
      const gf = Number(isHome ? r.goals.home : r.goals.away);
      const ga = Number(isHome ? r.goals.away : r.goals.home);
      const total = Number(r.goals.home) + Number(r.goals.away);
      const hth = r.score?.halftime?.home, hta = r.score?.halftime?.away;
      return { gf, ga, total, btts: Number(r.goals.home)>0 && Number(r.goals.away)>0,
        htTotal: hth == null || hta == null ? null : Number(hth)+Number(hta) };
    });
    const htVals = vals.filter(x => x.htTotal != null);
    const recentAvgGoalsFor = Number((vals.reduce((sum,x)=>sum+x.gf,0)/vals.length).toFixed(2));
    const recentAvgGoalsAgainst = Number((vals.reduce((sum,x)=>sum+x.ga,0)/vals.length).toFixed(2));
    const seasonStats = await fetchTeamSeasonGoals(teamId, leagueId, season, venue);
    // Blend the recent five-match form with the team's home/away season rate.
    // Recent form carries more weight (70%) so the season average stabilizes rather than overrides it.
    const blend = (recent, seasonal) => seasonal == null ? recent : Number((recent * 0.70 + seasonal * 0.30).toFixed(2));
    return {
      available: true, sampleSize: rows.length,
      teamGoalsOver05Pct: pct(x => x.gf >= 1),
      teamGoalsOver15Pct: pct(x => x.gf >= 2),
      goalsConcededPct: pct(x => x.ga > 0),
      over05Pct: pct(x => x.total >= 1), over15Pct: pct(x => x.total >= 2),
      over25Pct: pct(x => x.total >= 3), over35Pct: pct(x => x.total >= 4),
      bttsPct: pct(x => x.btts),
      htOver05Pct: htVals.length ? Math.round(100 * htVals.filter(x=>x.htTotal>=1).length / htVals.length) : null,
      htOver15Pct: htVals.length ? Math.round(100 * htVals.filter(x=>x.htTotal>=2).length / htVals.length) : null,
      avgGoalsFor: blend(recentAvgGoalsFor, seasonStats?.avgGoalsFor),
      avgGoalsAgainst: blend(recentAvgGoalsAgainst, seasonStats?.avgGoalsAgainst),
      recentAvgGoalsFor, recentAvgGoalsAgainst,
      seasonAvgGoalsFor: seasonStats?.avgGoalsFor ?? null,
      seasonAvgGoalsAgainst: seasonStats?.avgGoalsAgainst ?? null,
      seasonMatches: seasonStats?.played ?? null,
      matches: rows.map(r=>({score:`${r.goals.home}-${r.goals.away}`, halftimeScore:r.score?.halftime?.home==null?null:`${r.score.halftime.home}-${r.score.halftime.away}`}))
    };
  } catch (e) {
    console.warn(`[Team form] team=${teamId}: ${e.message}`);
    return { available: false, sampleSize: 0 };
  }
}

function liveStatsMetrics(stats, fixture) {
  const out = { available: false, shotsOnTarget: 0, totalShots: 0, corners: 0, xG: null,
    home: { shotsOnTarget: 0, totalShots: 0, corners: 0, xG: null }, away: { shotsOnTarget: 0, totalShots: 0, corners: 0, xG: null } };
  const seen = { home: new Set(), away: new Set() };
  for (const team of (Array.isArray(stats) ? stats : [])) {
    const teamId = Number(team.team?.id);
    const side = teamId === Number(fixture.homeId) ? "home" : teamId === Number(fixture.awayId) ? "away" : null;
    if (!side) continue;
    for (const st of (team.statistics || [])) {
      const type = String(st.type || "").toLowerCase();
      if (st.value == null || String(st.value).trim() === "" || /^[-—]+$/.test(String(st.value).trim())) continue;
      const value = Number(String(st.value).replace('%',''));
      if (!Number.isFinite(value)) continue;
      if (/expected goals|\bxg\b/.test(type)) { out[side].xG = value; out.xG = (Number(out.home.xG) || 0) + (Number(out.away.xG) || 0); seen[side].add("xG"); }
      else if (/shots on goal|shots on target/.test(type)) { out.shotsOnTarget += value; out[side].shotsOnTarget += value; seen[side].add("shotsOnTarget"); }
      else if (/total shots|goal attempts/.test(type)) { out.totalShots += value; out[side].totalShots += value; seen[side].add("totalShots"); }
      else if (/corner kicks|corners/.test(type)) { out.corners += value; out[side].corners += value; seen[side].add("corners"); }
    }
  }
  // A two-row response alone is not proof that usable live stats exist.
  out.available = seen.home.size > 0 && seen.away.size > 0;
  out.pressure = out.shotsOnTarget*2.5 + out.totalShots*0.45 + out.corners*0.8;
  return out;
}

function poissonProbabilityAtLeast(threshold, lambda, currentGoals = 0) {
  const need = Number(threshold) - Number(currentGoals || 0);
  if (need <= 0) return 1;
  let cumulative = 0;
  for (let k = 0; k < need; k++) cumulative += Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
  return Math.max(0, Math.min(1, 1 - cumulative));
}
function factorial(n) { let out = 1; for (let i = 2; i <= n; i++) out *= i; return out; }
function lambdaFromMarketProbability(probability, threshold, currentGoals = 0) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0.01 || p >= 0.99 || Number(currentGoals || 0) >= Number(threshold)) return null;
  let low = 0, high = 8;
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    if (poissonProbabilityAtLeast(threshold, mid, currentGoals) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
function marketProbabilitiesByName(oddsRow) {
  const rows = oddsForFixture(oddsRow);
  const grouped = new Map();
  for (const row of rows) {
    if (!Number.isFinite(Number(row.probability))) continue;
    if (!grouped.has(row.market)) grouped.set(row.market, []);
    grouped.get(row.market).push(row);
  }
  const result = {};
  for (const [market, values] of grouped) {
    // Bet365 varsa onu kullan; yoksa aynı pazardaki en yüksek güvenilir API olasılığını kullan.
    const preferred = values.find(value => /bet365/i.test(String(value.bookmaker || "")));
    const selected = preferred || values[0];
    result[market] = Number(selected.probability) / 100;
  }
  return result;
}
function scorePrediction(fixture, homeForm, awayForm, liveOddsRow = null, prematchOddsRow = null) {
  // Maç önü skor motoru: canlı maç kartta görünse bile mevcut skor/dakika kullanılmaz.
  const hasForm = Boolean(homeForm?.available && awayForm?.available);
  const pre = marketProbabilitiesByName(prematchOddsRow);
  const rows = oddsForFixture(prematchOddsRow);
  const outcomeRows = rows.filter(x => x.market === "MS 1" && x.outcomeProbabilities);
  const outcomeRow = outcomeRows.find(x => /bet365/i.test(String(x.bookmaker || ""))) || outcomeRows[0];
  const outcome = outcomeRow?.outcomeProbabilities || null;

  const totalLines = [["MS 1.5 ÜST",2],["MS 2.5 ÜST",3],["MS 3.5 ÜST",4],["MS 5.5 ÜST",6]];
  const totalLambdas = totalLines.map(([market,threshold]) => lambdaFromMarketProbability(pre[market],threshold,0)).filter(Number.isFinite).sort((a,b)=>a-b);
  const marketTotalLambda = totalLambdas.length ? totalLambdas[Math.floor((totalLambdas.length-1)/2)] : null;
  const marketHomeLambda = lambdaFromMarketProbability(pre["EV 1.5 ÜST"],2,0);
  const marketAwayLambda = lambdaFromMarketProbability(pre["DEP 1.5 ÜST"],2,0);
  const formHome = hasForm ? Math.max(0.08,0.58*Number(homeForm.avgGoalsFor||0)+0.42*Number(awayForm.avgGoalsAgainst||0)) : null;
  const formAway = hasForm ? Math.max(0.08,0.58*Number(awayForm.avgGoalsFor||0)+0.42*Number(homeForm.avgGoalsAgainst||0)) : null;

  // Team-goal markets set the split first. If absent, use 1X2 implied home/away
  // strength (draw excluded); form is the next fallback, never a fabricated score.
  let homeShare = null;
  if (marketHomeLambda != null && marketAwayLambda != null && marketHomeLambda+marketAwayLambda>0.05) homeShare=marketHomeLambda/(marketHomeLambda+marketAwayLambda);
  else if (outcome && outcome.home+outcome.away>0) homeShare=outcome.home/(outcome.home+outcome.away);
  else if (formHome != null && formAway != null && formHome+formAway>0) homeShare=formHome/(formHome+formAway);
  else if (marketHomeLambda != null) homeShare=0.58;
  else if (marketAwayLambda != null) homeShare=0.42;

  let lambdaHome=marketHomeLambda, lambdaAway=marketAwayLambda;
  if (lambdaHome==null || lambdaAway==null) {
    if (marketTotalLambda!=null && homeShare!=null) {
      if (lambdaHome==null) lambdaHome=marketTotalLambda*homeShare;
      if (lambdaAway==null) lambdaAway=marketTotalLambda*(1-homeShare);
    } else if (marketTotalLambda!=null) { lambdaHome=marketTotalLambda*0.5; lambdaAway=marketTotalLambda*0.5; }
  }
  if (lambdaHome!=null && formHome!=null) lambdaHome=0.85*lambdaHome+0.15*formHome;
  else if (lambdaHome==null) lambdaHome=formHome;
  if (lambdaAway!=null && formAway!=null) lambdaAway=0.85*lambdaAway+0.15*formAway;
  else if (lambdaAway==null) lambdaAway=formAway;
  if (marketTotalLambda!=null && lambdaHome!=null && lambdaAway!=null && lambdaHome+lambdaAway>0.05) {
    const target=0.85*marketTotalLambda+0.15*(lambdaHome+lambdaAway);
    const scale=target/(lambdaHome+lambdaAway); lambdaHome*=scale; lambdaAway*=scale;
  }
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return {
    halfTimeScore:"Tahmin üretilemedi", fullTimeScore:"Tahmin üretilemedi", alternativeFullTimeScore:"Tahmin üretilemedi",
    scoreBasis:"Maç önü gol oranı ve iki takım için yeterli son 5 maç verisi bulunamadı"
  };
  lambdaHome=Math.max(0.08,Math.min(4.5,lambdaHome)); lambdaAway=Math.max(0.08,Math.min(4.5,lambdaAway));
  const pmf=(k,l)=>Math.exp(-l)*Math.pow(l,k)/factorial(k);
  const scores=[];
  for(let h=0;h<=8;h++) for(let a=0;a<=8;a++) scores.push({home:h,away:a,probability:pmf(h,lambdaHome)*pmf(a,lambdaAway)});
  // Piyasa kalibrasyonu: önce bağımsız Poisson skor dağılımı kurulur,
  // ardından mevcut maç önü gol/BTTS/1X2 olasılıkları dağılıma uygulanır.
  // Böylece skor yalnızca iki lambda'nın matematiksel tepesine (sıklıkla 1-1)
  // bırakılmaz; gerçek piyasa sinyalleri skor olasılıklarını birlikte yönlendirir.
  const constraints = [];
  const addConstraint = (name, target, test) => {
    const p = Number(target);
    if (Number.isFinite(p) && p >= 0.04 && p <= 0.96) constraints.push({ name, target: p, test });
  };
  addConstraint("MS 1.5 ÜST", pre["MS 1.5 ÜST"], x => x.home + x.away >= 2);
  addConstraint("MS 2.5 ÜST", pre["MS 2.5 ÜST"], x => x.home + x.away >= 3);
  addConstraint("MS 3.5 ÜST", pre["MS 3.5 ÜST"], x => x.home + x.away >= 4);
  addConstraint("KG VAR", pre["KG VAR"], x => x.home > 0 && x.away > 0);
  addConstraint("EV 1.5 ÜST", pre["EV 1.5 ÜST"], x => x.home >= 2);
  addConstraint("DEP 1.5 ÜST", pre["DEP 1.5 ÜST"], x => x.away >= 2);
  if (outcome) {
    addConstraint("MS 1", outcome.home, x => x.home > x.away);
    addConstraint("MS X", outcome.draw, x => x.home === x.away);
    addConstraint("MS 2", outcome.away, x => x.away > x.home);
  }
  const normalizeScores = () => {
    const sum = scores.reduce((v, x) => v + x.probability, 0);
    if (sum > 0) for (const x of scores) x.probability /= sum;
  };
  normalizeScores();
  // Iterative proportional fitting: her pazarın piyasa olasılığına yaklaşırken
  // toplam skor dağılımının toplamı 1 kalır. Çelişkili pazarlar yumuşak uygulanır.
  for (let pass = 0; pass < 45 && constraints.length; pass++) {
    for (const c of constraints) {
      let current = 0;
      for (const x of scores) if (c.test(x)) current += x.probability;
      current = Math.max(0.005, Math.min(0.995, current));
      const target = Math.max(0.03, Math.min(0.97, c.target));
      const ratio = Math.pow((target / current) / ((1 - target) / (1 - current)), 0.16);
      for (const x of scores) x.probability *= c.test(x) ? ratio : 1;
      normalizeScores();
    }
  }
  scores.sort((a,b)=>b.probability-a.probability||(a.home+a.away)-(b.home+b.away)||b.home-a.home);
  const best=scores[0];
  const alternative=scores.find(x=>x.home!==best.home||x.away!==best.away);

  const ht05=lambdaFromMarketProbability(pre["İY 0.5 ÜST"],1,0);
  const ht15=lambdaFromMarketProbability(pre["İY 1.5 ÜST"],2,0);
  const htLines=[ht05,ht15].filter(Number.isFinite);
  const htTotal=htLines.length?htLines.reduce((sum,x)=>sum+x,0)/htLines.length:0.45*(lambdaHome+lambdaAway);
  const fullTotal=lambdaHome+lambdaAway;
  const htHome=fullTotal>0?htTotal*lambdaHome/fullTotal:htTotal/2;
  const htAway=fullTotal>0?htTotal*lambdaAway/fullTotal:htTotal/2;
  const htScores=[];
  for(let h=0;h<=5;h++) for(let a=0;a<=5;a++) htScores.push({home:h,away:a,p:pmf(h,htHome)*pmf(a,htAway)});
  htScores.sort((a,b)=>b.p-a.p||(a.home+a.away)-(b.home+b.away)||b.home-a.home);
  const basis=[];
  if(marketHomeLambda!=null||marketAwayLambda!=null||marketTotalLambda!=null) basis.push("Maç önü gol oranları (%85 ağırlık)");
  if(outcome) basis.push("MS 1X2 ev/beraberlik/deplasman dengesi");
  if(constraints.length) basis.push("gol, KG ve sonuç piyasalarıyla skor dağılımı kalibrasyonu");
  if(hasForm) basis.push("son 5 maç formu (%15 destek)");
  return {
    halfTimeScore:`${htScores[0].home}-${htScores[0].away} (tahmin)`,
    fullTimeScore:`${best.home}-${best.away} (tahmin)`,
    alternativeFullTimeScore:`${alternative.home}-${alternative.away} (alternatif tahmin)`,
    scoreBasis:basis.join(" + ")||"Maç önü oranları ve erişilebilen takım formu",
    expectedGoals:{home:Number(lambdaHome.toFixed(2)),away:Number(lambdaAway.toFixed(2))},
    scoreProbability:Number(best.probability.toFixed(4)),
    alternativeScoreProbability:Number(alternative.probability.toFixed(4))
  };
}

function analysisPercentages(oddsRow, homeForm, awayForm) {
  const map = { ht05: "İY 0.5 ÜST", ht15: "İY 1.5 ÜST", ms05: "MS 0.5 ÜST", ms15: "MS 1.5 ÜST", ms25: "MS 2.5 ÜST", ms35: "MS 3.5 ÜST", btts: "KG VAR", home15: "EV 1.5 ÜST", away15: "DEP 1.5 ÜST" };
  const rows = oddsForFixture(oddsRow); const out = {};
  for (const [key, market] of Object.entries(map)) {
    const o = rows.filter(x => x.market === market).sort((a,b)=>(/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || b.probability-a.probability)[0];
    const form = marketSupport(market, homeForm, awayForm);
    if (o || form != null) {
      const percent = o && form != null ? Math.round(o.probability * 0.55 + form * 0.45) : o ? Math.round(o.probability) : Math.round(form);
      out[key] = { percent, sampleSize: Math.min(homeForm?.sampleSize || 0, awayForm?.sampleSize || 0), source: o && form != null ? "Maç önü oranı + son 5 maç formu" : o ? "Maç önü oranı; form verisi eksik" : "Son 5 maç formu; maç önü oranı bulunamadı" };
    }
  }
  return out;
}

function marketConsistentWithScore(market, scoreObj) {
  const pair = value => {
    const m = String(value || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const ft = pair(scoreObj?.fullTimeScore);
  const htText = String(scoreObj?.halfTimeScore || "");
  const ht = /Canlı skor/i.test(htText) ? null : pair(htText);
  if (market === "KG VAR" && ft && (ft[0] < 1 || ft[1] < 1)) return false;
  if (market === "EV 1.5 ÜST" && ft && ft[0] < 2) return false;
  if (market === "DEP 1.5 ÜST" && ft && ft[1] < 2) return false;
  if (market === "MS 0.5 ÜST" && ft && ft[0] + ft[1] < 1) return false;
  if (market === "MS 1.5 ÜST" && ft && ft[0] + ft[1] < 2) return false;
  if (market === "MS 2.5 ÜST" && ft && ft[0] + ft[1] < 3) return false;
  if (market === "MS 3.5 ÜST" && ft && ft[0] + ft[1] < 4) return false;
  if (market === "İY 0.5 ÜST" && ht && ht[0] + ht[1] < 1) return false;
  if (market === "İY 1.5 ÜST" && ht && ht[0] + ht[1] < 2) return false;
  return true;
}

function chooseFormFallbackMarket(mode, fixture, forms, excludeMarket = null) {
  // Fallback only when no usable market odds are available. It is explicitly labelled
  // as form-based, never presented as an odds-backed signal.
  if (!forms?.home?.available || !forms?.away?.available) return null;
  const live = mode === "live";
  const minute = Number(fixture.minute || 0);
  if (live && (minute < 20 || minute > 85)) return null;
  const total = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
  let allowed;
  if (!live) allowed = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR", "MS 1.5 ÜST"];
  else if (minute < 33) allowed = total === 0 ? ["İY 0.5 ÜST"] : ["İY 1.5 ÜST", "MS 1.5 ÜST"];
  else if (minute < 45) allowed = total === 0 ? ["MS 1.5 ÜST"] : ["MS 1.5 ÜST", "KG VAR", "MS 2.5 ÜST"];
  else if (minute < 66) allowed = total === 0 ? ["MS 1.5 ÜST"] : total === 1 ? ["MS 1.5 ÜST", "KG VAR"] : ["MS 2.5 ÜST", "KG VAR"];
  else if (minute <= 75) allowed = total <= 1 ? ["MS 1.5 ÜST", "MS 2.5 ÜST", "KG VAR"] : ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  else allowed = total <= 1 ? ["MS 1.5 ÜST", "MS 2.5 ÜST"] : ["MS 2.5 ÜST", "MS 3.5 ÜST"];
  const thresholds = { "EV 1.5 ÜST": 45, "DEP 1.5 ÜST": 45, "MS 0.5 ÜST": 55, "MS 1.5 ÜST": 50, "MS 2.5 ÜST": 48, "MS 3.5 ÜST": 34, "KG VAR": 48, "İY 0.5 ÜST": 52, "İY 1.5 ÜST": 34 };
  const scoreObj = scorePrediction(fixture, forms.home, forms.away, null, null);
  const candidates = allowed.filter(m => m !== excludeMarket && marketConsistentWithScore(m, scoreObj))
    .map(m => ({ market: m, formPct: marketSupport(m, forms.home, forms.away), bookmaker: "Son 5 maç formu (oran bulunamadı)", oddsTiming: "form-fallback", probability: null }))
    .filter(x => x.formPct != null && x.formPct >= (thresholds[x.market] ?? 50))
    .sort((a,b) => b.formPct - a.formPct);
  return candidates[0] || null;
}

function liveMarketAlreadySettled(market, fixture) {
  const home = Number(fixture.homeScore || 0), away = Number(fixture.awayScore || 0), total = home + away;
  const minute = Number(fixture.minute || 0);
  if (market === "KG VAR" && home > 0 && away > 0) return true;
  if ((market === "EV 0.5 ÜST" || market === "EV 1.5 ÜST") && home >= (market.includes("1.5") ? 2 : 1)) return true;
  if ((market === "DEP 0.5 ÜST" || market === "DEP 1.5 ÜST") && away >= (market.includes("1.5") ? 2 : 1)) return true;
  const ms = market.match(/^MS ([0-9]+[.,][0-9]+) ÜST$/);
  if (ms && total >= Math.ceil(Number(ms[1].replace(",", ".")))) return true;
  const ht = market.match(/^İY ([0-9]+[.,][0-9]+) ÜST$/);
  if (ht) {
    if (minute >= 45) return true;
    const hg = Number(fixture.htHomeScore ?? home), ag = Number(fixture.htAwayScore ?? away);
    if (hg + ag >= Math.ceil(Number(ht[1].replace(",", ".")))) return true;
  }
  return false;
}

function chooseSupportedMarket(oddsRow, mode, fixture, forms, stats, prematchOddsRow, excludeMarket = null, preferredMarket = null) {
  const live = mode === "live";
  const total = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
  const minute = Number(fixture.minute || 0);
  // Canlı tercih: 20. dakikadan sonra; dakika/skor pazar eşleşmesi korunur. 85+ riskli.
  if (live && (minute < 20 || minute > 85)) return null;

  // Dakika + anlık skora göre izin verilen piyasalar (dayanak: kalan süre ve mevcut gol sayısı).
  let allowed;
  if (!live) {
    allowed = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 20 && minute < 33) {
    // 20–32. dakika: 0-0 ise İY 0.5; bir gol varsa İY 1.5, oran/form/istatistik desteğiyle değerlendirilir.
    if (total === 0) allowed = ["İY 0.5 ÜST"];
    else if (total === 1) allowed = ["İY 1.5 ÜST"];
    else allowed = ["İY 1.5 ÜST"];
  } else if (minute >= 33 && minute < 45) {
    // 33–44: ilk yarı pazarlarını otomatik önermiyoruz; kalan süre çok kısa ve
    // maç önü oranı, kalan ilk yarı dakikalarının olasılığı değildir.
    if (total === 0) allowed = ["MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 2.5 ÜST", "KG VAR"];
  } else if (minute >= 45 && minute < 55) {
    // 45–54: 0-0 iken MS 0.5 ÜST önerme; maç hareketliyse MS 1.5 ÜST değerlendir.
    if (total === 0) allowed = ["MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 55 && minute <= 65) {
    // 55–65: 0-0 iken de MS 1.5; baskı yoksa sinyal çıkmaz.
    if (total === 0) allowed = ["MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST", "KG VAR"];
  } else if (minute >= 66 && minute <= 75) {
    // 66+: MS 0.5 ÜST is allowed again, but an active 0-0 match should prefer MS 1.5 ÜST.
    if (total === 0) allowed = ["MS 1.5 ÜST", "MS 0.5 ÜST"];
    else if (total === 1) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST", "KG VAR"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
    else allowed = ["MS 3.5 ÜST"];
  } else {
    // 76–85: MS 0.5 ÜST is only available after 65'; pressure/value checks still apply.
    if (total === 0) allowed = ["MS 0.5 ÜST", "MS 1.5 ÜST"];
    else if (total === 1) allowed = ["MS 1.5 ÜST", "MS 2.5 ÜST"];
    else if (total === 2) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST"];
    else allowed = ["MS 3.5 ÜST"];
  }

  const h = forms.home, a = forms.away;
  // Canlı seçimde yalnızca gerçek canlı oran kullanılır. Maç önü oranı canlı fiyat
  // yerine geçirilmez; yoksa sistem canlı tercih üretmez.
  const liveMarketRows = live ? oddsForFixture(oddsRow || null) : [];
  const preMarkets = oddsForFixture(prematchOddsRow || (!live ? oddsRow : null) || null);
  const predictedScores = scorePrediction(fixture, h, a, live ? oddsRow : null, prematchOddsRow || (!live ? oddsRow : null) || null);
  const liveAllowedRows = liveMarketRows.filter(x => allowed.includes(x.market));
  const mergedMarketRows = live
    ? liveAllowedRows.map(x => ({ ...x, oddsTiming: "live" }))
    : preMarkets.map(x => ({ ...x, oddsTiming: "prematch" }));
  const choices = mergedMarketRows.filter(x => allowed.includes(x.market) && x.market !== excludeMarket &&
    // Maç önü ilk yarı oranı, canlı dakikaya uygun fiyat değildir; canlı HT marketlerinde kullanma.
    !(live && x.oddsTiming !== "live" && x.market.startsWith("İY ")) &&
    (!live || !liveMarketAlreadySettled(x.market, fixture)) &&
    (live || marketConsistentWithScore(x.market, predictedScores)));
  const statsM = stats || { available: false, pressure: 0, home: {}, away: {} };
  const favorite = (() => {
    const winners = preMarkets.filter(x => x.market === "MS 1");
    const home = winners.find(x => x.bookmaker && x.market === "MS 1" && x.homeOdd)?.homeOdd;
    const away = winners.find(x => x.bookmaker && x.market === "MS 1" && x.awayOdd)?.awayOdd;
    return home && away ? (home < away ? "home" : "away") : null;
  })();
  const leader = Number(fixture.homeScore || 0) > Number(fixture.awayScore || 0) ? "home"
    : Number(fixture.awayScore || 0) > Number(fixture.homeScore || 0) ? "away" : null;

  // Canlıda biraz daha sıkı eşikler: oran olasılığı + form birlikte doğrulanmalı.
  // Daha seçici eşikler: “bankoya yakın” hedefi için piyasa ve son-5 form desteği birlikte aranır.
  // Bunlar garanti değildir; yeterli destek yoksa tercih üretilmez.
  const minMarketPct = live ? {
    "EV 1.5 ÜST": 58, "DEP 1.5 ÜST": 58, "MS 2.5 ÜST": 58, "MS 3.5 ÜST": 48,
    "KG VAR": 58, "İY 0.5 ÜST": 56, "İY 1.5 ÜST": 48, "MS 0.5 ÜST": 64, "MS 1.5 ÜST": 60
  } : {
    "EV 1.5 ÜST": 60, "DEP 1.5 ÜST": 60, "MS 2.5 ÜST": 58, "MS 3.5 ÜST": 50,
    "KG VAR": 58, "İY 0.5 ÜST": 56, "İY 1.5 ÜST": 48, "MS 0.5 ÜST": 64, "MS 1.5 ÜST": 60
  };
  const minFormPct = {
    "EV 1.5 ÜST": 56, "DEP 1.5 ÜST": 56, "MS 2.5 ÜST": 56, "MS 3.5 ÜST": 48,
    "KG VAR": 56, "İY 0.5 ÜST": 54, "İY 1.5 ÜST": 46, "MS 0.5 ÜST": 58, "MS 1.5 ÜST": 56
  };

  const ranked = choices.map(choice => {
    const formPct = marketSupport(choice.market, h, a);
    let liveBonus = 0;
    let rejectReason = null;
    if (live) {
      if (!statsM.available) return null;

      // Canlı piyasa olasılığı seçim puanında kullanılır; maç önü oranı scorePrediction içinde referans olarak kalır.

      // 40. dakikadan sonra HT üst tercihlerini kapat; kalan süre çok kısa.
      if (choice.market.startsWith("İY ") && minute >= 40) return null;
      if (choice.market.startsWith("İY ")) {
        const currentHalfGoals = Number(fixture.htHomeScore ?? fixture.homeScore ?? 0) + Number(fixture.htAwayScore ?? fixture.awayScore ?? 0);
        const line = Number(choice.market.match(/(\d)[.,](\d)/)?.[1] || 0) + 0.5;
        if (currentHalfGoals >= Math.ceil(line)) return null;
        if (minute >= 33 && (Number(statsM.pressure || 0) < 18 || Number(statsM.shotsOnTarget || 0) < 3)) return null;
      }
      if (choice.market === "MS 0.5 ÜST" && total >= 1) return null;
      if (choice.market === "MS 0.5 ÜST" && total === 0 && minute < 66) return null;
      if (choice.market === "MS 0.5 ÜST" && total === 0 && minute >= 66
          && choices.some(x => x.market === "MS 1.5 ÜST")
          && Number(statsM.pressure || 0) >= 10
          && (Number(statsM.shotsOnTarget || 0) >= 2 || Number(statsM.totalShots || 0) >= 8 || Number(statsM.corners || 0) >= 6)) return null;
      if (choice.market === "MS 1.5 ÜST" && total >= 2) return null;
      // 0-0 at 45–65: only allow MS 1.5 ÜST when live match activity is real.
      if (choice.market === "MS 1.5 ÜST" && total === 0 && minute >= 45 && minute <= 65) {
        const activeMatch = Number(statsM.pressure || 0) >= 10
          && (Number(statsM.shotsOnTarget || 0) >= 2
            || Number(statsM.totalShots || 0) >= 8
            || Number(statsM.corners || 0) >= 6);
        if (!activeMatch) return null;
      }
      if (choice.market === "MS 2.5 ÜST" && total >= 3) return null;
      if (choice.market === "MS 3.5 ÜST" && total >= 4) return null;

      // Değer filtresi canlı oran varsa onu, yoksa açıkça etiketlenmiş maç önü oranını kullanır.
      // 1 gol varken MS 1.5 ÜST, 55. dakikadan sonra yeterli oran/form/baskı desteği varsa değerlendirilebilir.
      if (live && choice.market === "MS 1.5 ÜST" && total === 1) {
        if (minute < 55) return null;
        if (Number(choice.odd || 0) < 1.25) return null;
        if (Number(formPct || 0) < 55) return null;
        if (Number(choice.probability || 0) < 55 || Number(choice.probability || 0) > 82) return null;
        if (Number(statsM.pressure || 0) < 10) return null;
        if (Number(statsM.shotsOnTarget || 0) < 1 && Number(statsM.totalShots || 0) < 6) return null;
      }
      // Tek gol varken 2.5 ÜST en az iki gol daha gerektirir; sadece gerçek baskı ve yeterli fiyatla aday.
      if (live && choice.market === "MS 2.5 ÜST" && total === 1) {
        if (Number(choice.odd || 0) < 1.65) return null;
        if (Number(formPct || 0) < 55) return null;
        if (Number(statsM.pressure || 0) < 18) return null;
        if (Number(statsM.shotsOnTarget || 0) < 3 && Number(statsM.totalShots || 0) < 12) return null;
        if (minute >= 72 && Number(statsM.pressure || 0) < 22) return null;
      }

      const lineNum = Number(String(choice.market).match(/(\d)[.,](\d)/)?.[0]?.replace(",", ".") || 0);
      const needed = choice.market.startsWith("MS ") ? Math.max(0, Math.ceil(lineNum + 0.01) - total) : 1;

      // Kalan süreye göre gereken gol sayısı: ör. 80' 0-1'de MS 2.5 için
      // iki gol daha gerekir; sırf genel baskı puanı yüksek diye bu market seçilemez.
      const xg = Number(statsM.xG || 0);
      const remaining = Math.max(0, 96 - minute);
      if (live && choice.market.startsWith("MS ")) {
        if (needed <= 0) return null;
        if (minute >= 76 && needed >= 2) return null;
        if (minute >= 72 && needed >= 2 &&
            !(xg >= 2.4 && statsM.shotsOnTarget >= 6 && statsM.totalShots >= 17 && statsM.pressure >= 34)) return null;
        if (minute >= 80 && needed >= 1 &&
            !(xg >= 1.8 && statsM.shotsOnTarget >= 3 && statsM.pressure >= 22)) return null;
        if (minute >= 85 && needed >= 1 &&
            !(xg >= 2.5 && statsM.shotsOnTarget >= 5 && statsM.pressure >= 32)) return null;
        if (remaining <= 6 && needed >= 2) return null;
      }

      // Geç dakikada çok gol ihtiyacı + düşük baskı = red.
      if (minute >= 66 && needed > 1 && statsM.pressure < 16) return null;
      if (minute >= 72 && needed > 1 && statsM.pressure < 22) return null;
      if (minute >= 78 && needed >= 1 && statsM.pressure < 20) return null;
      if (minute >= 75 && choice.market === "MS 3.5 ÜST" && (needed > 1 || statsM.pressure < 26)) return null;

      // KG VAR: geride kalan favori takım baskısı şart.
      if (choice.market === "KG VAR") {
        if (total >= 2 && Number(fixture.homeScore || 0) > 0 && Number(fixture.awayScore || 0) > 0) return null; // zaten KG var
        if (leader && favorite && leader !== favorite) {
          const trailing = leader === "home" ? "away" : "home";
          const p = statsM[trailing] || {};
          const trailingPressure = Number(p.shotsOnTarget || 0) * 2.5 + Number(p.totalShots || 0) * 0.45 + Number(p.corners || 0) * 0.8;
          if (trailingPressure < 5.5 || Number(formPct || 0) < 50) return null;
          liveBonus += Math.min(14, trailingPressure * 0.55);
        } else if (!leader) {
          // Beraberlikte her iki tarafın da şut baskısı olmalı.
          const hp = Number(statsM.home?.shotsOnTarget || 0) + Number(statsM.away?.shotsOnTarget || 0);
          if (hp < 2 && statsM.pressure < 8) return null;
        }
      }

      // 0-0 / 1-0 senaryolarında erken-orta canlı: baskı eşiği.
      if (minute >= 55 && minute <= 65 && total === 0 && choice.market === "MS 0.5 ÜST" && statsM.pressure < 5.5) return null;
      if (minute >= 20 && minute < 33 && total === 0 && choice.market === "İY 0.5 ÜST" && statsM.pressure < 3.5) return null;

      // Genel baskı bonusu (isabetli şut ağırlıklı).
      liveBonus += Math.min(16, statsM.pressure * 0.28);
      // Dakika ilerledikçe üst gol piyasalarına hafif ceza (zaman riski).
      if (/MS [23][.,][05] ÜST/.test(choice.market)) {
        liveBonus -= Math.max(0, (minute - 60) * 0.22);
      }
    }

    if (choice.probability < minMarketPct[choice.market]) return null;
    if (formPct != null && formPct < minFormPct[choice.market]) return null;
    const estimatedPct = formPct == null ? Number(choice.probability) : Number(choice.probability) * 0.55 + Number(formPct) * 0.45;
    const impliedPct = Number(choice.odd) > 1.01 ? 100 / Number(choice.odd) : null;
    const valueEdge = impliedPct == null ? null : estimatedPct - impliedPct;
    // Prefer probability supported by both market and form, while rewarding genuine price value;
    // never choose a long price merely because the odds are high.
    const valueBonus = valueEdge == null ? 0 : Math.max(-8, Math.min(8, valueEdge * 0.45));
    const score = choice.probability * 0.62 + (formPct == null ? 0 : formPct * 0.20) + liveBonus + valueBonus
      - (live && choice.market === "MS 3.5 ÜST" ? Math.max(0, minute - 65) * 0.4 : 0);
    return {
      ...choice,
      formPct, estimatedPct: Math.round(estimatedPct * 10) / 10, valueEdge: valueEdge == null ? null : Math.round(valueEdge * 10) / 10,
      score,
      statsSummary: live ? statsM : null,
      liveContext: live ? { minute, total, pressure: statsM.pressure, neededGoals: choice.market.startsWith("MS ") ? Math.max(0, Math.ceil(Number(String(choice.market).match(/(\d)[.,](\d)/)?.[0]?.replace(",", ".") || 0) + 0.01) - total) : null } : null
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);

  if (preferredMarket) {
    const preferred = ranked.find(x => x.market === preferredMarket);
    if (preferred) return preferred;
  }
  if (ranked[0]) return ranked[0];

  // Gevşek fallback sadece maç önü analizinde kullanılabilir; canlıda eşikleri aşamaz.
  const fallback = live ? null : choices
    .filter(choice => Number.isFinite(Number(choice.probability)) && Number(choice.probability) >= 35)
    .sort((x, y) => Number(y.probability) - Number(x.probability) || Number(x.rank || 9) - Number(y.rank || 9))[0];
  if (fallback) return { ...fallback, score: Number(fallback.probability), fallbackUsed: true };

  // No usable odds: provide an explicitly heuristic score/minute scenario, never fake odds.
  const fallbackMarket = live ? null : allowed.find(m => m !== excludeMarket && marketConsistentWithScore(m, predictedScores));
  if (fallbackMarket) {
    return { market: fallbackMarket, bookmaker: "Skor/dakika senaryosu", oddsTiming: "scenario-estimate",
      probability: null, formPct: null, score: 1, fallbackUsed: true };
  }
  return null;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID tanımlı değil." };
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return { sent: true, messageId: result.result?.message_id ?? null };
}

function couponMessage(coupon) {
  const heading = coupon.type === "surprise" ? "🎲 WINSCOPE MAÇ ÖNÜ SÜRPRİZ 10 MAÇ" :
    coupon.type === "live" ? "⚡ WINSCOPE CANLI EN GÜVENİLİR TEK TERCİH" :
    "🎯 WINSCOPE MAÇ ÖNÜ KUPONU";
  const lines = [heading, `Tarih: ${coupon.date || "Bugün"}`, ""];
  coupon.picks.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.home} - ${p.away}`);
    lines.push(`Ana tercih: ${p.market}`);
    if (coupon.type === "live") {
      lines.push(`Alternatif tercih: ${p.alternativeMarket || "Yeterli takım sinyali yok"}`);
      lines.push(`Gol baskısı: ${p.pressureSide || "Belirlenemedi"}${p.pressureTeam ? ` (${p.pressureTeam})` : ""}`);
      if (p.alternativeBasis) lines.push(`Takım yönü dayanağı: ${p.alternativeBasis}`);
    }
    lines.push(`Lig: ${p.league}`);
    if (coupon.type === "live" || p.isLive) {
      if (p.minute != null) lines.push(`Dakika: ${p.minute}' | Skor: ${p.currentScore || "—"}`);
      if (p.source) lines.push(`Kaynak: ${p.source}`);
      if (p.oddsBasis) lines.push(`Oran dayanağı: ${p.oddsBasis}`);
      if (Array.isArray(p.statsSummary) && p.statsSummary.length) {
        lines.push(`Canlı istatistik: ${p.statsSummary.join(" · ")}`);
      }
      if (p.marketProbability != null) lines.push(`Piyasa olasılığı: %${Number(p.marketProbability).toFixed(1)}`);
      if (p.formSupport != null) lines.push(`Form desteği: %${Number(p.formSupport).toFixed(0)}`);
    }
    lines.push("");
  });
  if (coupon.type === "live") {
    lines.push("Dayanak: canlı oran varsa canlı piyasa; ilgili canlı pazar yoksa maç önü oranı açıkça ayrıştırılır. Son 5 maç formu, canlı baskı ve oran değeri birlikte değerlendirilir; gerçekleşmiş pazarlar önerilmez.");
  }
  return lines.join("\n");
}


async function getOddsForFixture(fixtureId, date) {
  // Reuse date-level odds first, then query the exact fixture. Preserve errors so
  // diagnostics can distinguish an unsupported/empty market from an API failure.
  let row = null;
  const wantedId = Number(fixtureId);
  if (date) {
    try {
      const byDate = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      row = (byDate.response || []).find(x => Number(x.fixture?.id) === wantedId) || null;
    } catch (e) {
      console.warn(`[Odds] date lookup failed date=${date}: ${e.message}`);
    }
  }
  if (!row) {
    try {
      const byFixture = await cachedProviderRequest(`odds-fixture:${wantedId}`, `/odds?fixture=${encodeURIComponent(wantedId)}`, 90000);
      row = (byFixture.response || []).find(x => Number(x.fixture?.id) === wantedId) || null;
    } catch (e) {
      console.warn(`[Odds] fixture lookup failed fixture=${wantedId}: ${e.message}`);
      throw e;
    }
  }
  if (!row) console.warn(`[Odds] no prematch odds row returned for fixture=${wantedId} date=${date || "unknown"}`);
  return row;
}

async function getFixtureForLiveAnalysis(fixtureId) {
  // /fixtures?id= can briefly disagree with /fixtures?live=all. Trust the live
  // list when it contains this fixture, avoiding a false NS response for a live match.
  const payload = await cachedProviderRequest(`fixture:${fixtureId}`, `/fixtures?id=${encodeURIComponent(fixtureId)}`, 15000);
  let row = (payload.response || []).find(x => Number(x.fixture?.id ?? x.id) === Number(fixtureId)) || null;
  if (!row) return null;
  if (normalizeProviderMatch(row).status !== "LIVE") {
    try {
      const livePayload = await cachedProviderRequest("liveList", "/fixtures?live=all", 60000);
      const liveRow = (livePayload.response || []).find(x => Number(x.fixture?.id ?? x.id) === Number(fixtureId));
      if (liveRow) row = liveRow;
    } catch (e) {
      console.warn(`[Live status] live-list verification failed fixture=${fixtureId}: ${e.message}`);
    }
  }
  return row;
}

function rankSingleMatchChoices(choices, mode = "prematch") {
  const allowed = choices.filter(x => x.odd >= 1.15 && x.odd <= 2.10);
  return allowed.sort((a, b) => {
    // Conservative odds first; tie-break with market hierarchy, not invented percentages.
    return Math.abs(a.odd - 1.35) - Math.abs(b.odd - 1.35) || a.rank - b.rank;
  });
}


async function sendCouponAutomatically(coupon, chosen) {
  await archiveDatabaseReady;
  const originalPicks = coupon.picks || [];
  const alreadySent = new Set(telegramSentKeys);
  if (databasePool && originalPicks.length) {
    try {
      const ids = originalPicks.map(p => Number(p.fixtureId)).filter(Boolean);
      if (ids.length) {
        const rows = await databasePool.query(
          "SELECT fixture_id, coupon_type, market FROM winscope_telegram_delivery_sent WHERE fixture_id = ANY($1::bigint[])", [ids]
        );
        for (const row of rows.rows) alreadySent.add(telegramDeliveryKey(row.fixture_id, row.coupon_type, row.market));
      }
    } catch (error) { console.warn(`[Telegram] Tekrar kontrolü DB'de yapılamadı: ${error.message}`); }
  }
  const remainingPicks = originalPicks.filter(p => !Number(p.fixtureId) ||
    !alreadySent.has(telegramDeliveryKey(p.fixtureId, coupon.type, p.market)));
  if (!remainingPicks.length) return { sent: false, duplicateSuppressed: true, reason: "Bu maç ve tercih pazarı daha önce gönderilmiş; tekrar gönderilmedi." };
  const remainingKeys = new Set(remainingPicks.map(p => telegramDeliveryKey(p.fixtureId, coupon.type, p.market)));
  coupon = { ...coupon, picks: remainingPicks };
  chosen = (chosen || []).filter(p => !Number(p.fixtureId) || remainingKeys.has(telegramDeliveryKey(p.fixtureId, coupon.type, p.market)));
  const signature = `${coupon.date}|${coupon.type}|${chosen.map(p => `${p.fixtureId}:${p.market}`).sort().join(",")}`;
  const now = Date.now();
  for (const [key, at] of telegramDeliveryCache) if (now - at > 24 * 60 * 60 * 1000) telegramDeliveryCache.delete(key);
  if (telegramDeliveryCache.has(signature)) {
    return { sent: false, duplicateSuppressed: true, reason: "Bu kupon imzası daha önce gönderilmiş; tekrar gönderilmedi." };
  }
  try {
    const result = await sendTelegram(couponMessage(coupon));
    if (result.sent) {
      telegramDeliveryCache.set(signature, now);
      if (telegramDeliveryCache.size > 500) telegramDeliveryCache.delete(telegramDeliveryCache.keys().next().value);
      if (coupon.autoGenerated) {
        for (const p of (coupon.picks || [])) {
          if (p.fixtureId) autoSentFixtureKeys.add(autoLivePickKey(coupon.type, coupon.date, p));
        }
      }
      for (const p of (coupon.picks || [])) {
        const fixtureId = Number(p.fixtureId);
        if (!fixtureId) continue;
        const deliveryKey = telegramDeliveryKey(fixtureId, coupon.type, p.market);
        telegramSentKeys.add(deliveryKey);
        if (databasePool) {
          try {
            await databasePool.query(
              `INSERT INTO winscope_telegram_delivery_sent(fixture_id, coupon_type, market, match_date, telegram_message_id)
               VALUES ($1, $2, $3, $4::date, $5) ON CONFLICT (fixture_id, coupon_type, market) DO NOTHING`,
              [fixtureId, coupon.type, String(p.market || ""),
               /^\d{4}-\d{2}-\d{2}$/.test(String(coupon.date || "")) ? coupon.date : null,
               result.messageId]
            );
          } catch (error) { console.warn(`[Telegram] Tekrar kaydı saklanamadı fixture=${fixtureId}: ${error.message}`); }
        }
      }
      const sourceLabel = coupon.type === "live" ? "Canlı en güvenilir tek tercih" : coupon.type === "surprise" ? "Maç önü sürpriz kuponu" : "Günün kuponu";
      for (const p of (coupon.picks || [])) {
        const fixtureId = Number(p.fixtureId);
        if (!fixtureId) continue;
        const score = String(p.currentScore || "0-0");
        goalTrackedFixtures.set(fixtureId, { home: p.home, away: p.away, league: p.league, sourceLabel, baselineScore: score });
        // Kupon üretilirken bilinen skor başlangıç kabul edilir.
        if (!goalScoreCache.has(fixtureId)) goalScoreCache.set(fixtureId, score);
        if (coupon.type === "live") {
          const trackedMarket = String(p.market || "");
          const existingLive = livePredictionTracking.find(x => x.fixtureId === fixtureId && x.market === trackedMarket);
          if (!existingLive) {
            const trackedLive = {
              fixtureId, home: String(p.home || ""), away: String(p.away || ""),
              market: trackedMarket, league: String(p.league || ""),
              matchDate: String(coupon.date || new Date().toISOString().slice(0,10)), startScore: score,
              minute: Number.isFinite(Number(p.minute)) ? Number(p.minute) : null,
              actualScore: null, outcome: null, settled: false, createdAt: new Date().toISOString()
            };
            livePredictionTracking.unshift(trackedLive);
            if (livePredictionTracking.length > 500) livePredictionTracking.length = 500;
            if (databasePool) {
              try {
                await databasePool.query(
                  `INSERT INTO winscope_live_predictions(fixture_id,home_team,away_team,market,signal_key,league,match_date,start_score,minute)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(fixture_id,market) DO NOTHING`,
                  [trackedLive.fixtureId,trackedLive.home,trackedLive.away,trackedLive.market,
                   `${trackedLive.fixtureId}:${trackedLive.market}`,trackedLive.league,
                   /^\\d{4}-\\d{2}-\\d{2}$/.test(trackedLive.matchDate) ? trackedLive.matchDate : null,
                   trackedLive.startScore,trackedLive.minute]
                );
              } catch (error) { console.error(`[Live tracking] fixture=${fixtureId}: ${error.message}`); }
            }
          }
        }
      }
    }
    return result;
  } catch (error) {
    console.error(`[Telegram] Otomatik kupon gönderimi başarısız (${coupon.type}):`, error.message);
    return { sent: false, error: error.message };
  }
}


function isExcludedAnalysisCompetition(match) {
  const text = `${match.league || ""} ${match.country || ""}`.toLowerCase();
  return /\b(women|woman|ladies|feminine|youth|reserve|reserves|u(?:16|17|18|19|20|21|23)|under[- ]?(?:16|17|18|19|20|21|23)|academy|junior|development league|premier league 2)\b/.test(text);
}

function automaticLeaguePriority(match) {
  const league = String(match.league || "").toLowerCase();
  const country = String(match.country || "").toLowerCase();
  if (league.includes("premier league") || league === "la liga" || league.includes("serie a") || league.includes("bundesliga") || league.includes("ligue 1")) return 1;
  if (league.includes("eredivisie") || league.includes("primeira liga") || league.includes("championship") || league.includes("champions league") || league.includes("europa league") || league.includes("conference league")) return 2;
  if (["england", "spain", "italy", "germany", "france", "portugal", "netherlands"].includes(country)) return 3;
  return 4;
}

async function createCouponByMode(date, mode = "prematch", options = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Geçerli bir maç tarihi seç.");
  const isLiveMode = mode === "live";
  const fixturePath = isLiveMode ? "/fixtures?live=all" : `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`;
  const fixtureKey = isLiveMode ? "liveList" : `fixtures:${date}`;
  const fixturePayload = await cachedProviderRequest(fixtureKey, fixturePath, isLiveMode ? 60_000 : 60_000);
  const allFixtures = (fixturePayload.response || []).map(normalizeProviderMatch)
    .filter(m => m.id && !isExcludedAnalysisCompetition(m) &&
      (isLiveMode ? m.status === "LIVE" && Number(m.minute || 0) >= 25 && Number(m.minute || 0) <= 80 : m.status === "NS"));
  // Büyük ligleri önceliklendir; aynı öncelikte erken başlayacak maçları öne al.
  allFixtures.sort((a, b) => automaticLeaguePriority(a) - automaticLeaguePriority(b) ||
    String(a.fixtureDate || "").localeCompare(String(b.fixtureDate || "")));
  // Otomatik tarama ilk birkaç maçla sınırlı kalmasın; API istek kuyruğu hız sınırını korur.
  // Maç önü havuzunu sabit 20/35 maçla kesme: bültenin tamamını oran eşleştirmesine al.
  // Canlı taramada API kotası ve hız için ayrı, sınırlı havuz kullanılır.
  // Genişletilmiş otomatik canlı tarama: uygun maç ilk 12'de değilse kaçırılmasın.
  // API kota koruması, önbellek ve istek kuyruğu aynen korunur.
  const fixtures = isLiveMode
    ? allFixtures.slice(0, options.automatic ? 25 : 25)
    : allFixtures;
  if (!fixtures.length) return { draftId:`coupon-${Date.now()}`, date, type:mode, status:"NO_MATCHES", picks:[], message:isLiveMode ? "Şu anda uygun dakika aralığında canlı maç bulunamadı." : "Seçilen tarihte başlamamış maç bulunamadı." };

  const dateOdds = new Map();
  if (!isLiveMode) {
    // API-Football /odds uç noktası sayfalanır. Tek sayfayı okumak 390 maçın yalnızca
    // küçük bir bölümünün oranlarını getirir; toplam sayfa bitene kadar sayfaları tara.
    try {
      const first = await cachedProviderRequest(`odds-date:${date}:page:1`, `/odds?date=${encodeURIComponent(date)}&page=1`, 15 * 60 * 1000);
      for (const row of (first.response || [])) if (row.fixture?.id) dateOdds.set(Number(row.fixture.id), row);
      const reportedPages = Math.max(1, Number(first.paging?.total || 1));
      const totalPages = Math.min(50, reportedPages);
      if (reportedPages > totalPages) console.warn(`[Coupon] Güvenlik sınırı: ${reportedPages} oran sayfasının ilk ${totalPages} sayfası kullanılıyor.`);
      for (let page = 2; page <= totalPages; page++) {
        const payload = await cachedProviderRequest(`odds-date:${date}:page:${page}`, `/odds?date=${encodeURIComponent(date)}&page=${page}`, 15 * 60 * 1000);
        for (const row of (payload.response || [])) if (row.fixture?.id) dateOdds.set(Number(row.fixture.id), row);
      }
      console.log(`[Coupon] Piyasa oran sayfaları tamamlandı: date=${date}, pages=${totalPages}, oddsFixtures=${dateOdds.size}`);
    } catch (e) { console.warn(`[Coupon] date odds pagination: ${e.message}`); }
  }
  const candidates = [], errors = [];
  const rejected = { noOdds: 0, noIds: 0, noForm: 0, noStats: 0, noMarket: 0, noSignal: 0, apiErrors: 0, duplicate: 0 };
  let fixturesToAnalyze = fixtures;
  if (!isLiveMode) {
    const withBulkOdds = fixtures.filter(f => dateOdds.has(f.id));
    const withoutBulkOdds = fixtures.filter(f => !dateOdds.has(f.id));
    // Önce bütün fikstürlerin oran sayfalarını tara; takım formu API kotasını korumak için
    // en fazla 50 oranlı ve 10 oran-yedek fikstürde çekilir. Canlı istatistik çağrısı yoktur.
    fixturesToAnalyze = [...withBulkOdds.slice(0, 50), ...withoutBulkOdds.slice(0, (options.automatic ? 0 : 2))];
  }
  let analyzedFixtures = 0;
  // Maç önü kuponunda ilk 2 adayı bulunca durma: daha geniş örneklemden
  // en iyi 2 tercihi sıralayabilmek için 10 aday hedefle. Nihai kupon boyutu 2 kalır.
  const targetPicks = mode === "surprise" ? 10 : mode === "prematch" ? 10 : 1;
  for (const fixture of fixturesToAnalyze) {
    // Yeterli sayıda yeni, doğrulanmış aday oluştuğunda gereksiz API çağrılarını kes.
    const uniqueCandidateCount = options.automatic
      ? candidates.filter(p => !autoSentFixtureKeys.has(autoLivePickKey(mode, date, p))).length
      : candidates.length;
    if (uniqueCandidateCount >= targetPicks) break;
    analyzedFixtures++;
    try {
      let marketOddsRow = null, prematchOddsRow = null, oddsBasis = "";
      if (isLiveMode) {
        const [prePayload, liveOddsPayload, statsPayload, homeForm, awayForm] = await Promise.all([
          cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000).catch(()=>({response:[]})),
          cachedProviderRequest(`odds-live-fixture:${fixture.id}`, `/odds/live?fixture=${fixture.id}`, 10000).catch(()=>({response:[]})),
          cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000),
          fetchTeamRecentForm(fixture.homeId, fixture.id, fixture.leagueId, fixture.season, "home"),
          fetchTeamRecentForm(fixture.awayId, fixture.id, fixture.leagueId, fixture.season, "away")
        ]);
        prematchOddsRow = (prePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        // Live odds providers may return a fixture in the bulk live feed even when
        // the fixture-specific query is empty. Check both shapes, without substituting
        // pre-match odds for a live price in the live selection logic.
        let liveOddsRow = (liveOddsPayload.response || []).find(row=>Number(row.fixture?.fixture?.id ?? row.fixture?.id ?? row.fixtureId ?? row.id)===fixture.id) || null;
        if (!liveOddsRow) {
          try {
            const allLiveOddsPayload = await cachedProviderRequest("odds-live-all", "/odds/live", 10000);
            liveOddsRow = (allLiveOddsPayload.response || []).find(row=>Number(row.fixture?.fixture?.id ?? row.fixture?.id ?? row.fixtureId ?? row.id)===fixture.id) || null;
            console.log(`[LIVE ODDS BULK CHECK] ${JSON.stringify({match:`${fixture.home} - ${fixture.away}`,fixtureId:fixture.id,fixtureQueryResults:(liveOddsPayload.response||[]).length,bulkResults:(allLiveOddsPayload.response||[]).length,bulkMatchFound:Boolean(liveOddsRow)})}`);
          } catch (e) {
            console.warn(`[LIVE ODDS BULK ERROR] fixture=${fixture.id}: ${e.message}`);
          }
        }
        marketOddsRow = liveOddsRow || prematchOddsRow;
        const statsRows = statsPayload.response || [];
        const stats = liveStatsMetrics(statsRows, fixture);
        if (!marketOddsRow) {
          rejected.noOdds++;
          console.warn(`[LIVE ODDS MISSING] ${JSON.stringify({match:`${fixture.home} - ${fixture.away}`,fixtureId:fixture.id,liveOddsResults:(liveOddsPayload.response||[]).length,prematchOddsFound:Boolean(prematchOddsRow),statsRows:statsRows.length,statsAvailable:stats.available})}`);
          continue;
        }
        if (!stats.available) { rejected.noStats++; continue; }
        if (!homeForm.available || !awayForm.available) { rejected.noForm++; continue; }
        const chosen = chooseSupportedMarket(liveOddsRow, mode, fixture, {home:homeForm,away:awayForm}, stats, prematchOddsRow);
        if (!chosen) { rejected.noSignal++; continue; }
        oddsBasis = chosen.oddsTiming === "live"
          ? `Gerçek canlı oran · ${chosen.bookmaker}`
          : `Canlı oran bulunamadı; maç önü oranı · ${chosen.bookmaker} (canlı oran değildir)`;
        const alternative = teamGoalAlternative(fixture, {home:homeForm, away:awayForm}, stats, liveOddsRow, prematchOddsRow);
        candidates.push({
          fixtureId: fixture.id, league: fixture.league, country: fixture.country,
          home: fixture.home, away: fixture.away, fixtureDate: fixture.fixtureDate,
          market: chosen.market, alternativeMarket: alternative?.market || null,
          pressureSide: alternative?.pressureSide || 'Belirlenemedi', pressureTeam: alternative?.pressureTeam || null,
          alternativeBasis: alternative?.basis || 'Takım bazlı canlı istatistik veya son 5 maç verisi eksik; alternatif taraf uydurulmadı.',
          source: chosen.bookmaker, oddsTiming: chosen.oddsTiming,
          internalOdd: chosen.odd, marketProbability: chosen.probability,
          formSupport: chosen.formPct, score: chosen.score,
          minute: fixture.minute, currentScore: `${fixture.homeScore}-${fixture.awayScore}`,
          isLive: true, oddsBasis,
          statsSummary: [
            `İsabetli şut: ${stats.shotsOnTarget}`,
            `Toplam şut: ${stats.totalShots}`,
            `Korner: ${stats.corners}`,
            `Baskı skoru: ${Number(stats.pressure || 0).toFixed(1)}`
          ]
        });
      } else {
        marketOddsRow = dateOdds.get(fixture.id) || null;
        if (!marketOddsRow) {
          const payload = await cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000);
          marketOddsRow = (payload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        }
        if (!marketOddsRow) { rejected.noOdds++; continue; }
        if (!fixture.homeId || !fixture.awayId) { rejected.noIds++; continue; }
        const [homeForm, awayForm] = await Promise.all([fetchTeamRecentForm(fixture.homeId,fixture.id,fixture.leagueId,fixture.season,"home"),fetchTeamRecentForm(fixture.awayId,fixture.id,fixture.leagueId,fixture.season,"away")]);
        if (!homeForm.available || !awayForm.available) { rejected.noForm++; continue; }
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, null, marketOddsRow);
        if (!chosen) { rejected.noSignal++; continue; }
        oddsBasis = "API-Football maç önü son mevcut oran kaydı; resmî kapanış olduğu garanti edilemez";
        candidates.push({fixtureId:fixture.id,league:fixture.league,country:fixture.country,home:fixture.home,away:fixture.away,
          fixtureDate:fixture.fixtureDate,market:chosen.market,source:chosen.bookmaker,internalOdd:chosen.odd,marketProbability:chosen.probability,
          formSupport:chosen.formPct,score:chosen.score,minute:null,currentScore:"0-0",isLive:false,oddsBasis,statsSummary:null});
      }
    } catch(e) {
      rejected.apiErrors++;
      const message = /istek sınırına ulaşıldı/i.test(e.message) ? "API-Football istek sınırı; kuyruk beklemesi devrede" : e.message;
      errors.push(`${fixture.home} - ${fixture.away}: ${message}`);
      if (/istek sınırına ulaşıldı/i.test(e.message)) break;
    }
  }
  // Otomatik gönderimlerde aynı gün daha önce gönderilmiş maçları yeniden seçme.
  const availableCandidates = options.automatic
    ? candidates.filter(p => !autoSentFixtureKeys.has(autoLivePickKey(mode, date, p)))
    : candidates;
  rejected.duplicate = candidates.length - availableCandidates.length;
  console.log(`[COUPON SCAN ${mode.toUpperCase()}] date=${date} live=${isLiveMode} fixtures=${allFixtures.length} prioritized=${fixtures.length} analyzed=${analyzedFixtures} candidates=${candidates.length} available=${availableCandidates.length} rejected=${JSON.stringify(rejected)} seasonStats=home-away-blend youthReserveWomen=excluded oddsPagesMax=50 errors=${errors.length}`);
  availableCandidates.sort((a,b)=>b.score-a.score || b.formSupport-a.formSupport || a.internalOdd-b.internalOdd);
  const count = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  const chosen = availableCandidates.slice(0,count);
  if (!chosen.length || (mode === "prematch" && chosen.length < 2)) {
    const needed = mode === "prematch" ? 2 : 1;
    return {draftId:`coupon-${Date.now()}`,date,type:mode,status:"NO_MATCHES",picks:[],
      message:`Maç önü oranı + son 5 maç formu${isLiveMode ? " + canlı istatistik" : ""} eşiklerini geçen yeterli maç yok (gereken: ${needed}). Kupon zorlanmadı.`,
      detail:`Fikstür: ${allFixtures.length}; oran sayfasından eşleşen: ${dateOdds.size}; form/statistik için incelenen: ${fixturesToAnalyze.length}; aday: ${candidates.length}; elenme: oran=${rejected.noOdds}, form=${rejected.noForm}, canlı-istatistik=${rejected.noStats}, piyasa-sinyali=${rejected.noSignal}, API-hatası=${rejected.apiErrors}, tekrar=${rejected.duplicate}. ${errors.slice(0,2).join(" | ")}`};
  }
  // internalOdd / score iç skorlama; canlı kupon Telegram'da olasılık + form + dk/skor gösterilsin.
  const publicPicks = chosen.map(({ internalOdd, score, ...p }) => p);
  const draftId = `coupon-${Date.now()}`;
  const coupon = {draftId,date,type:mode,isLive:isLiveMode,status:"READY",picks:publicPicks,autoGenerated:Boolean(options.automatic),
    message:mode==="live" ? "Tek canlı tercih: yalnızca maç önü oranı kullanıldı; dakika/skor + son 5 maç formu + canlı şut/korner baskısı değerlendirildi." :
      mode==="surprise" ? `Sürpriz kupon: ${publicPicks.length} maç (en fazla 10); yalnızca oran ve son 5 maç formu eşiğini geçen adaylar eklendi.` :
      "Maç önü kuponu: en az iki maç, maç önü son mevcut oran ve son 5 gerçek skor formu birlikte değerlendirildi."};
  const archiveCoupon = {date,type:mode,picks:publicPicks,createdAt:new Date().toISOString()};
  archives.coupons.unshift(archiveCoupon);
  archives.coupons=archives.coupons.slice(0,50);
  await saveArchiveItem("coupon", archiveCoupon);
  try {
    await archiveDatabaseReady;
    const trackingResult = await saveCouponTracking(coupon);
    console.log(`[Coupon tracking] Yeni kupon kayıtları: ${trackingResult.saved}; PostgreSQL=${trackingResult.persistent}`);
  } catch (trackingError) {
    console.error(`[Coupon tracking] Yeni kupon kaydedilemedi: ${trackingError.message}`);
  }
  // Onay butonu olmadan, kupon başarıyla üretildiğinde Telegram'a otomatik gönder.
  coupon.telegram = await sendCouponAutomatically(coupon, chosen);
  return coupon;
}

app.get("/api/telegram/status", async (_req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(503).json({
      ok: false,
      configured: false,
      botActive: false,
      chatConfigured: Boolean(TELEGRAM_CHAT_ID),
      message: "Render Environment içinde TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID kontrol edilmeli."
    });
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      return res.status(502).json({
        ok: false, configured: true, botActive: false,
        message: result.description || `Telegram API HTTP ${response.status}`
      });
    }
    return res.json({
      ok: true, configured: true, botActive: true,
      botUsername: result.result?.username || null,
      chatConfigured: true,
      message: "Bot token geçerli ve Telegram botu aktif. Chat ID'ye mesaj gönderme yetkisi ayrıca test edilmelidir."
    });
  } catch (e) {
    return res.status(502).json({
      ok: false, configured: true, botActive: false,
      message: `Telegram bağlantı testi başarısız: ${e.message}`
    });
  }
});

app.get("/api/health", (_req, res) => res.json({
  ok: true, apiKeyConfigured: Boolean(API_KEY),
  telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  databaseConfigured: Boolean(databasePool),
  provider: "API-Football", oddsPolicy: "pre-match odds for pre-match analysis; live analysis uses live odds first and pre-match odds only as a labeled fallback when no eligible live goal market exists", teamFormPolicy: "last five completed matches plus cached league-season home/away goal averages", oddsValuesHidden: true
}));

// Compatibility route used by the current index.html live-goal button.
// It performs a real live-data check and never invents odds or statistics.
app.get("/api/match/:id/live-goal-analysis", async (req, res) => {
  try {
    const fixtureId = Number(req.params.id);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: "Geçersiz maç kimliği." });
    }
    const [row, statsPayload, liveOddsPayload] = await Promise.all([
      getFixtureForLiveAnalysis(fixtureId),
      cachedProviderRequest(`stats:${fixtureId}`, `/fixtures/statistics?fixture=${fixtureId}`, 15000).catch(e => {
        console.warn(`[Live analysis] stats failed fixture=${fixtureId}: ${e.message}`); return { response: [] };
      }),
      cachedProviderRequest(`odds-live-fixture:${fixtureId}`, `/odds/live?fixture=${fixtureId}`, 10000).catch(e => {
        console.warn(`[Live analysis] live odds failed fixture=${fixtureId}: ${e.message}`); return { response: [] };
      })
    ]);
    let prematchOddsRow = null;
    try { prematchOddsRow = await getOddsForFixture(fixtureId, row?.fixture?.date?.slice(0, 10)); }
    catch (e) { console.warn(`[Live analysis] prematch odds failed fixture=${fixtureId}: ${e.message}`); }
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });
    const fixture = normalizeProviderMatch(row);
    if (fixture.status !== "LIVE") {
      return res.status(409).json({ error: "Bu maç API tarafından canlı olarak işaretlenmiyor; canlı gol analizi yapılmadı." });
    }
    const liveOddsRow = (liveOddsPayload.response || []).find(x => Number(x.fixture?.fixture?.id ?? x.fixture?.id ?? x.fixtureId) === fixtureId) || null;
    const stats = liveStatsMetrics(statsPayload.response || [], fixture);
    if (!stats.available) {
      return res.json({ fixtureId, currentScore: `${fixture.homeScore}-${fixture.awayScore}`, minute: fixture.minute,
        mainPick: null, alternative: null, oddsTiming: liveOddsRow ? "live" : "unavailable", stats: null,
        oddsBasis: "Canlı istatistikler API tarafından sağlanmadı.",
        note: "Canlı istatistikler eksik olduğu için tercih zorlanmadı." });
    }
    if (!fixture.homeId || !fixture.awayId) {
      return res.json({ fixtureId, currentScore: `${fixture.homeScore}-${fixture.awayScore}`, minute: fixture.minute,
        mainPick: null, alternative: null, oddsTiming: liveOddsRow ? "live" : "unavailable",
        stats: { totalShots: stats.totalShots, shotsOnTarget: stats.shotsOnTarget, corners: stats.corners, xG: stats.xG, pressure: Number(stats.pressure.toFixed(1)) },
        oddsBasis: "Takım kimlikleri bulunamadı.", note: "Takım formu doğrulanamadığı için tercih zorlanmadı." });
    }
    const [homeForm, awayForm] = await Promise.all([
      fetchTeamRecentForm(fixture.homeId, fixture.id, fixture.leagueId, fixture.season, "home"), fetchTeamRecentForm(fixture.awayId, fixture.id, fixture.leagueId, fixture.season, "away")
    ]);
    if (!homeForm.available || !awayForm.available) {
      return res.json({ fixtureId, currentScore: `${fixture.homeScore}-${fixture.awayScore}`, minute: fixture.minute,
        mainPick: null, alternative: null, oddsTiming: liveOddsRow ? "live" : "unavailable",
        stats: { totalShots: stats.totalShots, shotsOnTarget: stats.shotsOnTarget, corners: stats.corners, xG: stats.xG, pressure: Number(stats.pressure.toFixed(1)) },
        oddsBasis: "Son 5 maç form verisi eksik.", note: "Form verisi doğrulanamadığı için tercih zorlanmadı." });
    }
    const chosen = chooseSupportedMarket(liveOddsRow, "live", fixture, { home: homeForm, away: awayForm }, stats, prematchOddsRow);
    const alternative = chosen ? chooseSupportedMarket(liveOddsRow, "live", fixture, { home: homeForm, away: awayForm }, stats, prematchOddsRow, chosen.market) : null;
    const oddsTiming = chosen?.oddsTiming || (liveOddsRow ? "live" : (prematchOddsRow ? "prematch" : "unavailable"));
    const oddsBasis = chosen
      ? (chosen.oddsTiming === "live" ? `Gerçek canlı oran · ${chosen.bookmaker}` : `Canlı oran bulunamadı; maç önü oranı yedek olarak kullanıldı · ${chosen.bookmaker}`)
      : (liveOddsRow ? "Canlı oran var ancak dakika/skor/form/istatistik eşiklerini geçen market yok." : "Kullanılabilir canlı oran bulunamadı; eşikleri geçen doğrulanmış tercih yok.");
    res.json({ fixtureId, currentScore: `${fixture.homeScore}-${fixture.awayScore}`, minute: fixture.minute,
      mainPick: chosen?.market || null, alternative: alternative?.market || null, oddsTiming,
      stats: { totalShots: stats.totalShots, shotsOnTarget: stats.shotsOnTarget, corners: stats.corners, xG: stats.xG, pressure: Number(stats.pressure.toFixed(1)) },
      oddsBasis, note: chosen ? "Canlı skor, mevcut istatistikler, son 5 maç formu ve mevcut market verisi değerlendirildi. Ham oranlar gösterilmez." : "Güvenilir tercih eşiği karşılanmadığı için seçim zorlanmadı." });
  } catch (error) {
    const message = String(error?.message || error);
    const limited = /429|rate.?limit|quota|istek sınırı/i.test(message);
    res.status(limited ? 429 : 502).json({ error: limited ? "API kotası/sınırı nedeniyle canlı analiz şu an alınamıyor." : "Canlı gol analizi alınamadı.", detail: message });
  }
});

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });

    const match = normalizeProviderMatch(row);
    // WinScope test modu: canlı maç kartta görünür, analiz ise tamamen maç önü verisiyle yapılır.
    // Canlı oranlar ve canlı istatistikler bu endpointte kesinlikle kullanılmaz.
    const prematchFixture = {
      ...match,
      status: "NS",
      minute: null,
      homeScore: 0,
      awayScore: 0,
      htHomeScore: null,
      htAwayScore: null
    };

    const [prematchRow, homeForm, awayForm] = await Promise.all([
      getOddsForFixture(match.id, match.fixtureDate ? String(match.fixtureDate).slice(0, 10) : null).catch(e => {
        console.warn(`[Prematch analysis] odds failed fixture=${match.id}: ${e.message}`); return null;
      }),
      fetchTeamRecentForm(match.homeId, match.id, match.leagueId, match.season, "home"),
      fetchTeamRecentForm(match.awayId, match.id, match.leagueId, match.season, "away")
    ]);
    const forms = { home: homeForm, away: awayForm };
    const scores = scorePrediction(prematchFixture, homeForm, awayForm, null, prematchRow);

    // Tercih yalnızca maç önü piyasasında gerçekten bulunan oranlardan seçilir.
    const chosen = prematchRow
      ? chooseSupportedMarket(prematchRow, "prematch", prematchFixture, forms, null, prematchRow)
      : null;
    const ftMatch = String(scores.fullTimeScore || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    const scoreSuggestsBtts = Boolean(ftMatch && Number(ftMatch[1]) > 0 && Number(ftMatch[2]) > 0);
    const alternative = chosen
      ? chooseSupportedMarket(prematchRow, "prematch", prematchFixture, forms, null, prematchRow, chosen.market, scoreSuggestsBtts ? "KG VAR" : null)
      : null;

    const percentages = analysisPercentages(prematchRow, homeForm, awayForm);
    const marketNames = oddsForFixture(prematchRow).map(x => x.market);
    const marketAvailable = name => marketNames.includes(name);
    res.json({
      fixtureId: match.id,
      matchStatus: match.status,
      analysisMode: "PREMATCH_ONLY",
      halfTimeScore: scores.halfTimeScore,
      fullTimeScore: scores.fullTimeScore,
      alternativeFullTimeScore: scores.alternativeFullTimeScore || "Alternatif skor hesaplanamadı",
      scoreBasis: scores.scoreBasis || "Maç önü oranları ve erişilebilen son 5 maç formu",
      mainPick: chosen?.market || "Maç önü oranlarından doğrulanmış tercih bulunamadı",
      alternative: alternative?.market || "Doğrulanmış alternatif bulunamadı",
      livePick: "Canlı analiz kapalı — maç önü analizi",
      livePickBasis: "Canlı oran ve canlı istatistik kullanılmıyor.",
      marketPercentages: percentages,
      markets: {
        ht1x2: marketAvailable("İY 1X2"),
        ft1x2: marketAvailable("MS 1X2"),
        ht05: marketAvailable("İY 0.5 ÜST"),
        ht15: marketAvailable("İY 1.5 ÜST"),
        btts: marketAvailable("KG VAR"),
        ms15: marketAvailable("MS 1.5 ÜST"),
        ms25: marketAvailable("MS 2.5 ÜST"),
        ms35: marketAvailable("MS 3.5 ÜST"),
        ms55: marketAvailable("MS 5.5 ÜST"),
        ah05: marketAvailable("AH -0.5")
      },
      note: prematchRow
        ? `${chosen?.bookmaker || "Maç önü oran kaydı"} ve erişilebilen takım formu değerlendirildi. Ham oranlar arayüzde gösterilmez.`
        : "Bu maç için API-Football üzerinden maç önü oran kaydı alınamadı. Skor tahmini yalnızca mevcut takım formu verisiyle üretilebilir; oran dayanaklı tercih üretilmedi.",
      oddsBasis: prematchRow
        ? "Yalnızca API-Football maç önü oranları; canlı oranlar kullanılmadı."
        : "Maç önü oranı bulunamadı.",
      htMarketAlreadyHit: false
    });
  } catch (e) {
    res.status(502).json({ error: "Maç önü analizi üretilemedi.", detail: e.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 60_000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches, fetchedAt: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: "Canlı maçlar alınamadı", detail: e.message, matches: [] }); }
});

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Tarih YYYY-MM-DD biçiminde olmalı." });
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches });
  } catch (e) { res.status(502).json({ error: "Bülten alınamadı", detail: e.message, matches: [] }); }
});


app.get("/api/coupon/daily", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/surprise", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "surprise")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "surprise", picks: [], error: "10 maçlık sürpriz kupon oluşturulamadı.", detail: e.message }); }
});
async function liveCouponHandler(_req, res) {
  res.json({
    status: "DISABLED",
    type: "live",
    picks: [],
    error: "Canlı analiz şimdilik kapalı. Canlı maçlar yalnızca listelenir; analiz maç önü oranlarıyla yapılır."
  });
}
app.get("/api/coupon/live-best", liveCouponHandler);
app.get("/api/coupon/live", liveCouponHandler);
app.get("/api/live-combo", liveCouponHandler);

app.post("/api/analyses/approve", async (req, res) => {
  const body = req.body || {};
  if (!body.fixtureId || !body.home || !body.away) return res.status(400).json({ success: false, error: "Maç bilgileri eksik." });
  const approved = {
    fixture_id: Number(body.fixtureId), home_team: String(body.home), away_team: String(body.away),
    analysis: body.analysis || {}, created_at: new Date().toISOString()
  };
  archives.analyses.unshift(approved);
  archives.analyses = archives.analyses.slice(0, 100);
  const storage = await saveArchiveItem("analysis", approved);
  const parseScore = value => {
    const match = String(value || "").match(/(\d+)\s*[-:]\s*(\d+)/);
    return match ? `${Number(match[1])}-${Number(match[2])}` : null;
  };
  const tracking = {
    fixtureId:Number(body.fixtureId), home:String(body.home), away:String(body.away),
    predictedHT:parseScore(approved.analysis.halfTimeScore),
    predictedFT:parseScore(approved.analysis.fullTimeScore),
    alternativeFT:parseScore(approved.analysis.alternativeFullTimeScore),
    actualHT:null, actualFT:null, exactFT:null, exactHT:null,
    matchDate:String(body.matchDate || ""), settled:false, createdAt:new Date().toISOString()
  };
  const existing = predictionTracking.findIndex(x => x.fixtureId === tracking.fixtureId);
  if (existing >= 0) predictionTracking[existing] = tracking; else predictionTracking.unshift(tracking);
  let trackingPersisted = false;
  if (databasePool) {
    try {
      await archiveDatabaseReady;
      await databasePool.query(`INSERT INTO winscope_predictions(fixture_id,home_team,away_team,predicted_ht,predicted_ft,alternative_ft,match_date)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(fixture_id) DO UPDATE SET home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,
        predicted_ht=EXCLUDED.predicted_ht,predicted_ft=EXCLUDED.predicted_ft,alternative_ft=EXCLUDED.alternative_ft,match_date=EXCLUDED.match_date,
        actual_ht=NULL,actual_ft=NULL,exact_ft=NULL,exact_ht=NULL,settled_at=NULL`,
        [tracking.fixtureId,tracking.home,tracking.away,tracking.predictedHT,tracking.predictedFT,tracking.alternativeFT,tracking.matchDate]);
      trackingPersisted = true;
    } catch (error) { console.error(`[Prediction tracking] ${error.message}`); }
  }
  res.json({ success: true, persisted: storage.persisted, trackingPersisted, storageReason: storage.reason || storage.error || null });
});

app.get("/api/predictions/summary", async (_req, res) => {
  await archiveDatabaseReady;
  const rows = predictionTracking;
  const settled = rows.filter(x => x.settled && x.actualFT);
  const exactFT = settled.filter(x => x.exactFT === true).length;
  const exactHTRows = settled.filter(x => x.exactHT !== null);
  res.json({ total:rows.length, settled:settled.length, pending:rows.length-settled.length,
    exactFullTime:exactFT, exactFullTimeRate:settled.length?Math.round(100*exactFT/settled.length):null,
    exactHalfTime:exactHTRows.filter(x=>x.exactHT===true).length,
    exactHalfTimeRate:exactHTRows.length?Math.round(100*exactHTRows.filter(x=>x.exactHT===true).length/exactHTRows.length):null,
    results:settled.slice(0,100), note:"Yalnızca kullanıcı tarafından onaylanıp takip kaydına alınan analizler ölçülür." });
});

// Canlı tercih takip paneli: yalnızca Telegram'a gerçekten gönderilen canlı seçimleri sayar.
app.get("/api/live-predictions/summary", async (req, res) => {
  await archiveDatabaseReady;
  const period = req.query.period === "all" ? "all" : "week";
  let rows = [];
  let storageError = null;
  if (databasePool) {
    try {
      const result = period === "week"
        ? await databasePool.query(`SELECT fixture_id,home_team,away_team,market,league,match_date,start_score,minute,actual_score,outcome,settled_at,created_at
            FROM winscope_live_predictions WHERE created_at >= NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 500`)
        : await databasePool.query(`SELECT fixture_id,home_team,away_team,market,league,match_date,start_score,minute,actual_score,outcome,settled_at,created_at
            FROM winscope_live_predictions ORDER BY created_at DESC LIMIT 500`);
      rows = result.rows.map(row => ({
        fixtureId:Number(row.fixture_id), home:row.home_team, away:row.away_team, market:row.market, league:row.league,
        matchDate:row.match_date, startScore:row.start_score, minute:row.minute, actualScore:row.actual_score,
        outcome:row.outcome, settled:Boolean(row.settled_at), createdAt:row.created_at
      }));
    } catch (error) {
      storageError = error.message;
      console.error(`[Live tracking summary] PostgreSQL okunamadı: ${error.message}`);
      rows = livePredictionTracking.filter(x => period === "all" || Date.now() - new Date(x.createdAt || 0).getTime() <= 7 * 86400000);
    }
  } else {
    rows = livePredictionTracking.filter(x => period === "all" || Date.now() - new Date(x.createdAt || 0).getTime() <= 7 * 86400000);
  }
  const settled = rows.filter(x => x.settled && (x.outcome === "won" || x.outcome === "lost"));
  const won = settled.filter(x => x.outcome === "won").length;
  const lost = settled.filter(x => x.outcome === "lost").length;
  res.json({
    period, total: rows.length, pending: rows.filter(x => !x.settled).length, won, lost,
    winRate: settled.length ? Math.round(100 * won / settled.length) : null,
    lossRate: settled.length ? Math.round(100 * lost / settled.length) : null,
    results: rows.slice(0, 50),
    persistentStorage: Boolean(databasePool), storageError,
    note: "Canlı tercih kayıtları PostgreSQL'den okunur; varsayılan dönem son 7 gündür. Yalnızca desteklenen pazarlar sonuçlandırılır."
  });
});

app.get("/api/coupon-tracking/summary", async (req, res) => {
  await archiveDatabaseReady;
  const period = req.query.period === "all" ? "all" : "week";
  let rows = [];
  let storageError = null;
  if (databasePool) {
    try {
      const result = period === "all"
        ? await databasePool.query(`SELECT coupon_key,coupon_type,fixture_id,home_team,away_team,league,market,start_score,actual_score,outcome,match_date,created_at,settled_at
            FROM winscope_coupon_predictions ORDER BY created_at DESC LIMIT 2000`)
        : await databasePool.query(`SELECT coupon_key,coupon_type,fixture_id,home_team,away_team,league,market,start_score,actual_score,outcome,match_date,created_at,settled_at
            FROM winscope_coupon_predictions WHERE created_at >= NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 2000`);
      rows = result.rows.map(row => ({
        couponKey: row.coupon_key, couponType: row.coupon_type, fixtureId: Number(row.fixture_id),
        home: row.home_team, away: row.away_team, league: row.league, market: row.market,
        startScore: row.start_score, actualScore: row.actual_score, outcome: row.outcome,
        matchDate: row.match_date, settled: Boolean(row.settled_at), createdAt: row.created_at
      }));
    } catch (error) {
      storageError = error.message;
      console.error(`[Coupon tracking summary] PostgreSQL okunamadı: ${error.message}`);
    }
  }

  // Kupon sonuçları tek tek maç tercihlerinden değil, coupon_key gruplarından hesaplanır.
  const couponMap = new Map();
  for (const row of rows) {
    const key = String(row.couponKey || `${row.couponType}:${row.matchDate || ""}:${row.createdAt || ""}`);
    if (!couponMap.has(key)) couponMap.set(key, {
      couponKey: key, couponType: row.couponType, matchDate: row.matchDate,
      createdAt: row.createdAt, legs: []
    });
    couponMap.get(key).legs.push(row);
  }
  const coupons = [...couponMap.values()].map(coupon => {
    const legs = coupon.legs;
    const lost = legs.some(x => x.settled && x.outcome === "lost");
    const won = legs.length > 0 && legs.every(x => x.settled && x.outcome === "won");
    const outcome = lost ? "lost" : won ? "won" : null;
    return {
      ...coupon, legCount: legs.length, settled: Boolean(outcome), outcome,
      pendingLegs: legs.filter(x => !x.settled).length,
      actualScore: legs.map(x => `${x.home} ${x.actualScore || "Bekliyor"} ${x.away}`).join(" · ")
    };
  }).sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const settled = coupons.filter(x => x.settled);
  const won = settled.filter(x => x.outcome === "won").length;
  const lost = settled.filter(x => x.outcome === "lost").length;
  const byTypeMap = new Map();
  for (const coupon of settled) {
    const key = coupon.couponType || "prematch";
    const item = byTypeMap.get(key) || { couponType: key, won: 0, lost: 0 };
    item[coupon.outcome]++;
    byTypeMap.set(key, item);
  }
  const byCouponType = [...byTypeMap.values()].map(x => ({
    ...x, winRate: x.won + x.lost ? Math.round(100*x.won/(x.won+x.lost)) : 0
  }));
  res.json({
    period, total: coupons.length, settled: settled.length,
    pending: coupons.filter(x => !x.settled).length, won, lost,
    winRate: settled.length ? Math.round(100*won/settled.length) : null,
    byCouponType, results: coupons.slice(0,100), persistentStorage: Boolean(databasePool), storageError,
    note: "Kupon başarı oranı kupon bazında hesaplanır; tüm ayaklar kazanırsa kupon kazanır, bir ayak kaybederse kupon kaybeder."
  });
});

app.get("/api/archives", async (_req, res) => {
  await archiveDatabaseReady;
  const actualByFixture = new Map(predictionTracking
    .filter(item => item.actualFT)
    .map(item => [Number(item.fixtureId), { actualFT: item.actualFT, actualHT: item.actualHT || null, exactFT: item.exactFT }]));
  const analyses = archives.analyses.map(item => {
    const fixtureId = Number(item.fixture_id || item.fixtureId || 0);
    const actual = actualByFixture.get(fixtureId);
    return { ...item, actualFullTimeScore: actual?.actualFT || item.actualFullTimeScore || null,
      actualHalfTimeScore: actual?.actualHT || item.actualHalfTimeScore || null,
      exactFullTime: actual?.exactFT ?? null };
  });
  res.json({ analyses, coupons: archives.coupons, persistentStorage: Boolean(databasePool) });
});

app.get("/api/match/:id/stats", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`stats:${req.params.id}`, `/fixtures/statistics?fixture=${encodeURIComponent(req.params.id)}`, 30000);
    res.json({ success: true, stats: payload.response || [] });
  } catch (e) { res.status(502).json({ success: false, error: "İstatistik alınamadı.", detail: e.message, stats: [] }); }
});

// Otomatik Telegram akışı: canlı tek tercih açılışta ve her 20 dakikada;
// günün maç önü kuponu açılışta ve ardından 2 saatte bir. Buton gerekmez.
function turkeyDateString() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function runAutomaticLivePick() {
  if (autoLiveTaskInFlight) return;
  autoLiveTaskInFlight = true;
  try {
    const date = turkeyDateString();
    const result = await createCouponByMode(date, "live", { automatic: true });
    if (result.status === "READY" && result.telegram?.sent && !result.telegram?.duplicateSuppressed) {
      console.log(`[AUTO LIVE] Telegram kabul etti message_id=${result.telegram.messageId ?? "bilinmiyor"}: ${result.picks?.[0]?.home} - ${result.picks?.[0]?.away}`);
    } else if (result.telegram?.duplicateSuppressed) {
      console.log(`[AUTO LIVE] Tekrar engellendi; yeni Telegram mesajı gönderilmedi: ${result.telegram.reason || "aynı maç/pazar daha önce gönderilmiş"}`);
    } else {
      console.log(`[AUTO LIVE] Telegram bildirimi gönderilmedi: ${result.message || result.telegram?.reason || result.telegram?.error || result.status}`);
    }
  } catch (error) {
    console.error(`[AUTO LIVE ERROR] ${error.message}`);
  } finally {
    autoLiveTaskInFlight = false;
  }
}

async function runAutomaticDailyCoupon() {
  if (autoPrematchTaskInFlight) return;
  autoPrematchTaskInFlight = true;
  try {
    const date = turkeyDateString();
    const result = await createCouponByMode(date, "prematch", { automatic: true });
    if (result.status === "READY" && result.telegram?.sent) {
      console.log(`[AUTO DAILY] Telegram'a günün kuponu gönderildi: ${result.picks?.length || 0} maç`);
    } else {
      console.log(`[AUTO DAILY] Yeni ve uygun iki maç bulunamadı veya gönderim başarısız: ${result.message || result.telegram?.reason || result.telegram?.error || result.status}`);
    }
  } catch (error) {
    console.error(`[AUTO DAILY ERROR] ${error.message}`);
  } finally {
    autoPrematchTaskInFlight = false;
  }
}

// Canlı tek tercih otomatik taraması: her 90 saniyede bir. Günün maç önü kuponu 2 saatte bir.
setTimeout(() => { void runAutomaticLivePick(); }, 20000);
// Günün maç önü kuponunu da sunucu açıldıktan kısa süre sonra dene;
// yalnızca interval kullanılırsa ilk bildirim 2 saate kadar gecikebilirdi.
setTimeout(() => { void runAutomaticDailyCoupon(); }, 30000);
setInterval(() => { void runAutomaticLivePick(); }, 90 * 1000);
setInterval(() => { void runAutomaticDailyCoupon(); }, 2 * 60 * 60 * 1000);

// Her 60 saniyede bir Telegram'a gönderilmiş kupon maçlarının skor değişimini kontrol et.
// Böylece gol alarmı yalnızca kupon mesajı atmakla kalmaz, maçtaki skor değişimini de bildirir.
setInterval(async () => {
  if (goalScanInFlight || goalTrackedFixtures.size === 0) return;
  goalScanInFlight = true;
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 60_000);
    const liveMatches = (payload.response || []).map(normalizeProviderMatch);
    const liveById = new Map(liveMatches.map(m => [Number(m.id), m]));
    for (const [fixtureId, tracked] of goalTrackedFixtures.entries()) {
      const match = liveById.get(fixtureId);
      if (!match || match.status !== "LIVE") continue;
      const score = `${match.homeScore}-${match.awayScore}`;
      const previous = goalScoreCache.get(fixtureId) ?? tracked.baselineScore ?? score;
      if (score === previous) continue;
      const message = `⚽ WINSCOPE GOOOOOL!\n🏆 ${match.league || tracked.league || "Lig"}\n⚽ ${match.home || tracked.home} - ${match.away || tracked.away}\n📣 Skor değişti: ${previous} → ${score}\n⏱️ Dakika: ${match.minute ?? "?"}'\n🎯 Takip nedeni: ${tracked.sourceLabel}`;
      try {
        const sent = await sendTelegram(message);
        if (sent.sent) {
          goalScoreCache.set(fixtureId, score);
          tracked.baselineScore = score;
          console.log(`[GOOOOL Alert OK] ${fixtureId} ${previous} -> ${score}`);
        }
      } catch (error) {
        console.error(`[GOOOOL Alert Error] ${fixtureId}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[GOOOOL Scan Error] ${error.message}`);
  } finally {
    goalScanInFlight = false;
  }
}, 60_000);

async function settleCouponPredictions() {
  if (!databasePool) return;
  const pending = await databasePool.query(`SELECT tracking_id,fixture_id,market,coupon_type,home_team,away_team,league,
      telegram_notified_at
    FROM winscope_coupon_predictions
    WHERE settled_at IS NULL OR (outcome='won' AND telegram_notified_at IS NULL)
    ORDER BY created_at ASC LIMIT 40`);
  for (const item of pending.rows) {
    try {
      let outcome = null;
      let actualScore = null;
      if (!item.telegram_notified_at) {
        const payload = await cachedProviderRequest(`coupon-settle:${item.fixture_id}`, `/fixtures?id=${item.fixture_id}`, 5 * 60 * 1000);
        const row = payload.response?.[0];
        const status = String(row?.fixture?.status?.short || "").toUpperCase();
        if (!row || !["FT","AET","PEN"].includes(status) || row.goals?.home == null || row.goals?.away == null) continue;
        const homeGoals = Number(row.goals.home), awayGoals = Number(row.goals.away);
        const htHome = row.score?.halftime?.home == null ? null : Number(row.score.halftime.home);
        const htAway = row.score?.halftime?.away == null ? null : Number(row.score.halftime.away);
        const result = evaluateTrackedLiveMarket(item.market, homeGoals, awayGoals, htHome, htAway);
        if (result == null) continue;
        actualScore = `${homeGoals}-${awayGoals}`;
        outcome = result ? "won" : "lost";
        const updated = await databasePool.query(
          `UPDATE winscope_coupon_predictions SET actual_score=$2,outcome=$3,settled_at=NOW()
           WHERE tracking_id=$1 AND settled_at IS NULL RETURNING tracking_id`,
          [item.tracking_id, actualScore, outcome]
        );
        if (!updated.rowCount) continue;
      } else {
        outcome = "won";
      }

      // Kazanan her tercih için Telegram'a tek bildirim gönder; başarısız gönderim
      // sonraki settlement taramasında yeniden denenir.
      if (outcome === "won" && !item.telegram_notified_at) {
        const message = [
          "🏆 WINSCOPE KUPON TERCİHİ KAZANDI!",
          `🏟️ ${item.league || "Lig bilgisi yok"}`,
          `⚽ ${item.home_team} - ${item.away_team}`,
          `🎯 Kazanan tercih: ${item.market}`,
          `📊 Maç sonucu: ${actualScore}`,
          `📌 Kupon türü: ${item.coupon_type === "live" ? "Canlı" : item.coupon_type === "surprise" ? "Sürpriz" : "Maç önü"}`
        ].join("\n");
        const sent = await sendTelegram(message);
        if (sent.sent) {
          await databasePool.query(
            "UPDATE winscope_coupon_predictions SET telegram_notified_at=NOW() WHERE tracking_id=$1 AND telegram_notified_at IS NULL",
            [item.tracking_id]
          );
          console.log(`[Coupon WIN Telegram] Bildirim gönderildi tracking_id=${item.tracking_id} message_id=${sent.messageId ?? "?"}`);
        } else {
          console.warn(`[Coupon WIN Telegram] Bildirim gönderilemedi tracking_id=${item.tracking_id}: ${sent.reason || "Telegram yapılandırılmamış"}`);
        }
      }
    } catch (error) {
      console.warn(`[Coupon tracking settlement] fixture=${item.fixture_id}: ${error.message}`);
    }
  }
}
setTimeout(() => { void settleCouponPredictions(); }, 30_000);
setInterval(() => { void settleCouponPredictions(); }, 15 * 60 * 1000);

app.use("/api", (_req, res) => res.status(404).json({ error: "API uç noktası bulunamadı." }));
function evaluateTrackedLiveMarket(market, homeGoals, awayGoals, halfHome, halfAway) {
  const m = String(market || "").toLocaleUpperCase("tr-TR").replace(/İ/g, "I").replace(/Ü/g, "U").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ç/g, "C").replace(/Ö/g, "O");
  if (m.includes("KG VAR")) return homeGoals > 0 && awayGoals > 0;
  if (m.includes("KG YOK")) return homeGoals === 0 || awayGoals === 0;
  const homeLine = m.match(/(?:EV|EV SAHIBI)\s*(\d+(?:[.,]\d+)?)\s*(UST|ALT)/);
  if (homeLine) return homeLine[2] === "UST" ? homeGoals > Number(homeLine[1].replace(",", ".")) : homeGoals < Number(homeLine[1].replace(",", "."));
  const awayLine = m.match(/(?:DEP|DEPLASMAN)\s*(\d+(?:[.,]\d+)?)\s*(UST|ALT)/);
  if (awayLine) return awayLine[2] === "UST" ? awayGoals > Number(awayLine[1].replace(",", ".")) : awayGoals < Number(awayLine[1].replace(",", "."));
  const ht = m.includes("IY ") || m.includes("ILK YARI") || m.includes("HALF");
  const h = ht ? halfHome : homeGoals, a = ht ? halfAway : awayGoals;
  if (ht && (h == null || a == null)) return null;
  const over = m.match(/(?:MS |IY |ILK YARI )?(\d+(?:[.,]\d+)?)\s*UST/);
  const under = m.match(/(?:MS |IY |ILK YARI )?(\d+(?:[.,]\d+)?)\s*ALT/);
  if (over) return h + a > Number(over[1].replace(",", "."));
  if (under) return h + a < Number(under[1].replace(",", "."));
  return null;
}
async function settleLivePredictions() {
  const pending = livePredictionTracking.filter(x => !x.settled).slice(0, 30);
  for (const item of pending) {
    try {
      const payload = await cachedProviderRequest(`live-settle:${item.fixtureId}`, `/fixtures?id=${item.fixtureId}`, 5 * 60 * 1000);
      const row = payload.response?.[0];
      const status = String(row?.fixture?.status?.short || "").toUpperCase();
      if (!row || !["FT","AET","PEN"].includes(status) || row.goals?.home == null || row.goals?.away == null) continue;
      const homeGoals = Number(row.goals.home), awayGoals = Number(row.goals.away);
      const htHome = row.score?.halftime?.home == null ? null : Number(row.score.halftime.home);
      const htAway = row.score?.halftime?.away == null ? null : Number(row.score.halftime.away);
      const result = evaluateTrackedLiveMarket(item.market, homeGoals, awayGoals, htHome, htAway);
      if (result == null) {
        console.warn(`[Live tracking] Desteklenmeyen pazar sonuçlandırılmadı fixture=${item.fixtureId} market=${item.market}`);
        continue;
      }
      item.actualScore = `${homeGoals}-${awayGoals}`;
      item.outcome = result ? "won" : "lost";
      item.settled = true;
      item.settledAt = new Date().toISOString();
      if (databasePool) {
        await databasePool.query(
          "UPDATE winscope_live_predictions SET actual_score=$3,outcome=$4,settled_at=NOW() WHERE fixture_id=$1 AND market=$2",
          [item.fixtureId,item.market,item.actualScore,item.outcome]
        );
      }
    } catch (error) { console.warn(`[Live prediction settlement] fixture=${item.fixtureId}: ${error.message}`); }
  }
}
async function settleApprovedPredictions() {
  if (!predictionTracking.some(x => !x.settled)) return;
  for (const item of predictionTracking.filter(x => !x.settled).slice(0, 20)) {
    try {
      const payload = await cachedProviderRequest(`settle-fixture:${item.fixtureId}`, `/fixtures?id=${item.fixtureId}`, 5 * 60 * 1000);
      const row = payload.response?.[0];
      const status = String(row?.fixture?.status?.short || "").toUpperCase();
      if (!row || !["FT","AET","PEN"].includes(status) || row.goals?.home == null || row.goals?.away == null) continue;
      const actualFT = `${Number(row.goals.home)}-${Number(row.goals.away)}`;
      const ht = row.score?.halftime;
      const actualHT = ht?.home == null || ht?.away == null ? null : `${Number(ht.home)}-${Number(ht.away)}`;
      item.actualFT = actualFT; item.actualHT = actualHT;
      item.exactFT = item.predictedFT ? item.predictedFT === actualFT : null;
      item.exactHT = item.predictedHT && actualHT ? item.predictedHT === actualHT : null;
      item.settled = true; item.settledAt = new Date().toISOString();
      if (databasePool) await databasePool.query(`UPDATE winscope_predictions SET actual_ht=$2,actual_ft=$3,exact_ft=$4,exact_ht=$5,settled_at=NOW() WHERE fixture_id=$1`,
        [item.fixtureId,actualHT,actualFT,item.exactFT,item.exactHT]);
    } catch (error) { console.warn(`[Prediction settlement] fixture=${item.fixtureId}: ${error.message}`); }
  }
}
// Sunucu açıldığında geçmişte onaylanan analizlerin biten maç skorlarını da hemen eşitle.
setTimeout(() => { void settleApprovedPredictions(); }, 5000);
setInterval(() => { void settleApprovedPredictions(); }, 15 * 60 * 1000);
setInterval(() => { void settleLivePredictions(); }, 15 * 60 * 1000);

app.listen(PORT, () => console.log(`WinScope server running on port ${PORT}`));
