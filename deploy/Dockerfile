FROM nginxinc/nginx-unprivileged:alpine

COPY css/*.css /usr/share/nginx/html/webswr/css/
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/webswr/index.html
COPY js/*.js /usr/share/nginx/html/webswr/js/