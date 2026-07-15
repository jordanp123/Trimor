FROM nginxinc/nginx-unprivileged:alpine

# URL path segment the site is served under (config.webswr SUBPATH, passed as
# a build arg by docker-compose). "." serves at the domain root instead --
# nginx simply serves whatever directory layout lands under html/.
ARG SUBPATH=webswr

COPY css/*.css /usr/share/nginx/html/${SUBPATH}/css/
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/${SUBPATH}/index.html
COPY js/*.js /usr/share/nginx/html/${SUBPATH}/js/
